/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { toGeminiContents, toGeminiRequest, createGeminiAgentClient } from '../gemini-anthropic-adapter'

describe('gemini-adapter request translation', () => {
  it('maps roles, tool_use and tool_result (by tool name) and merges same-role turns', () => {
    const contents = toGeminiContents([
      { role: 'user', content: 'hej' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'secret', signature: '' },
          { type: 'text', text: 'Kollar.' },
          { type: 'tool_use', id: 't1', name: 'get_x', input: { a: 1 }, gemini_thought_signature: 'sig' },
          { type: 'tool_use', id: 't2', name: 'get_y', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
          { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'fel' }], is_error: true },
        ],
      },
      { role: 'user', content: 'och sen?' },
    ])

    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user'])
    const model = contents[1].parts
    expect(model).toHaveLength(3) // thinking dropped
    expect(model[1]).toEqual({ functionCall: { name: 'get_x', args: { a: 1 } }, thoughtSignature: 'sig' })
    // Second call of a parallel batch carries no signature.
    expect(model[2].thoughtSignature).toBeUndefined()
    const user = contents[2].parts
    expect(user[0]).toEqual({ functionResponse: { name: 'get_x', response: { result: 'ok' } } })
    expect(user[1]).toEqual({ functionResponse: { name: 'get_y', response: { error: 'fel' } } })
    expect(user[2]).toEqual({ text: 'och sen?' })
  })

  it('uses the skip sentinel for unsigned history (e.g. from Bedrock)', () => {
    const contents = toGeminiContents([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }] },
    ])
    expect(contents[1].parts[0].thoughtSignature).toBe('skip_thought_signature_validator')
  })

  it('translates system blocks, tools, forced tool_choice and thinking; drops cache_control', () => {
    const body = toGeminiRequest({
      model: 'eu.anthropic.claude-sonnet-4-6',
      max_tokens: 5000,
      system: [
        { type: 'text', text: 'A', cache_control: { type: 'ephemeral' } } as never,
        { type: 'text', text: 'B' },
      ],
      messages: [{ role: 'user', content: 'q' }],
      tools: [{ name: 'f', description: 'd', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'tool', name: 'f' },
      thinking: { type: 'enabled', budget_tokens: 1000 },
    }) as Record<string, any>

    expect(body.systemInstruction).toEqual({ parts: [{ text: 'A\n\nB' }] })
    expect(body.tools[0].functionDeclarations[0]).toEqual({
      name: 'f',
      description: 'd',
      parametersJsonSchema: { type: 'object', properties: {} },
    })
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['f'] } })
    expect(body.generationConfig).toEqual({
      maxOutputTokens: 5000,
      thinkingConfig: { includeThoughts: true, thinkingBudget: 1000 },
    })
    expect(JSON.stringify(body)).not.toContain('cache_control')
  })
})

describe('gemini-adapter adaptive thinking', () => {
  it('maps adaptive thinking + output_config.effort to thinkingLevel', () => {
    const body = toGeminiRequest({
      max_tokens: 100,
      messages: [{ role: 'user', content: 'q' }],
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'xhigh' },
    }) as Record<string, any>
    expect(body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'high' })
    expect(JSON.stringify(body)).not.toContain('output_config')
  })
})

describe('gemini-adapter streaming', () => {
  afterEach(() => vi.unstubAllGlobals())

  function sse(chunks: object[]): Response {
    const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')
    return new Response(text, { status: 200 })
  }

  it('emits text + thinking + tool chips and assembles an Anthropic-shaped message', async () => {
    process.env.AI_API_KEY = 'k'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sse([
          { candidates: [{ content: { parts: [{ text: 'tänker', thought: true }] } }] },
          { candidates: [{ content: { parts: [{ text: 'Hej ' }] } }] },
          { candidates: [{ content: { parts: [{ text: 'där' }] } }] },
          {
            candidates: [
              {
                content: { parts: [{ functionCall: { name: 'f', args: { a: 1 } }, thoughtSignature: 'S' }] },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2 },
          },
        ]),
      ),
    )

    const stream = createGeminiAgentClient().messages.stream({ max_tokens: 100, messages: [{ role: 'user', content: 'q' }] })
    const text: string[] = []
    const events: any[] = []
    stream.on('text', (d) => text.push(d))
    stream.on('streamEvent', (e) => events.push(e))
    const msg = await stream.finalMessage()

    expect(text.join('')).toBe('Hej där')
    expect(events.some((e) => e.delta?.type === 'thinking_delta')).toBe(true)
    expect(events.some((e) => e.type === 'content_block_start' && e.content_block.name === 'f')).toBe(true)
    expect(msg.stop_reason).toBe('tool_use')
    expect(msg.content.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use'])
    expect(msg.content[2]).toMatchObject({ name: 'f', input: { a: 1 }, gemini_thought_signature: 'S' })
    expect(msg.usage).toEqual({ input_tokens: 10, output_tokens: 7 })
  })

  it('rejects finalMessage with a status-bearing error on HTTP 429', async () => {
    process.env.AI_API_KEY = 'k'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('quota', { status: 429 })))
    const stream = createGeminiAgentClient().messages.stream({ max_tokens: 100, messages: [{ role: 'user', content: 'q' }] })
    await expect(stream.finalMessage()).rejects.toMatchObject({ status: 429 })
  })
})

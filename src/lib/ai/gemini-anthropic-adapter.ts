// HT patch. Gemini backend for the agent, shaped like the slice of the Anthropic SDK
// the agent actually uses: `messages.create(...)` and `messages.stream(...)`
// with `.on('text' | 'streamEvent')` + `.finalMessage()`.
//
// The chat loop, composer and intents stay written against Anthropic's
// message format; this adapter translates on the wire:
//
//   Anthropic                         Gemini (generativelanguage v1beta)
//   system (string | text blocks)  →  systemInstruction
//   role 'assistant'               →  role 'model'
//   text / image / document        →  text / inline_data
//   tool_use {id,name,input}       →  functionCall {name,args} (+ thoughtSignature)
//   tool_result {tool_use_id}      →  functionResponse {name,response}
//   tools[].input_schema           →  functionDeclarations[].parametersJsonSchema
//   tool_choice {type:'tool'}      →  toolConfig ANY + allowedFunctionNames
//   thinking {budget_tokens}       →  thinkingConfig {includeThoughts,thinkingBudget}
//   thinking adaptive + effort     →  thinkingConfig {includeThoughts,thinkingLevel}
//   cache_control                  →  dropped (Gemini caches implicitly)
//
// Thought signatures: Gemini 3 models return an opaque `thoughtSignature` on
// function-call parts and reject the follow-up request unless it is echoed
// back. We carry it on the tool_use block (`gemini_thought_signature`), which
// also survives persistence. History loaded from before this adapter (or
// from Bedrock) has none; Gemini documents a sentinel value for that case.
//
// Wired in by createAiClient() (./provider.ts) when AI_PROVIDER is
// openai-compatible and AI_BASE_URL points at Google's Gemini endpoint: the
// job-shaped services keep using that OpenAI-compatible URL, while the
// Anthropic-shaped callers (chat loop, composer, receipt hunt, WhatsApp) get
// this adapter against Gemini's native API with the same key (AI_API_KEY).
//
// NOTE: Gemini's free tier lets Google use prompts to improve its products.
// The agent sees bookkeeping data — prefer a billed key for production.

import { randomUUID } from 'node:crypto'

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

// Documented escape hatch for function calls that lack a real signature
// (e.g. history produced by another model).
const SKIP_SIGNATURE = 'skip_thought_signature_validator'

export function geminiAgentModel(): string {
  return process.env.AI_ASSISTANT_MODEL || process.env.AI_MODEL || 'gemini-3.8-flash'
}

// --- Anthropic-shaped types (only the fields we read/write) ---------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type Block = any

interface AnthropicParams {
  model?: string
  max_tokens?: number
  temperature?: number
  system?: string | Array<{ type: string; text?: string }>
  messages: Array<{ role: 'user' | 'assistant'; content: string | Block[] }>
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>
  tool_choice?: { type: 'auto' | 'any' | 'tool' | 'none'; name?: string }
  thinking?: { type: 'enabled' | 'disabled' | 'adaptive'; budget_tokens?: number; display?: string }
  output_config?: { effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
}

// Anthropic effort levels → Gemini thinkingLevel.
const THINKING_LEVEL: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
}

export interface AnthropicLikeMessage {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: Block[]
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens'
  stop_sequence: null
  usage: { input_tokens: number; output_tokens: number }
}

// --- Gemini wire types ---------------------------------------------------

interface GeminiPart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  inline_data?: { mime_type: string; data: string }
  inlineData?: { mimeType: string; data: string }
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string }
  functionResponse?: { name: string; response: Record<string, unknown> }
}

interface GeminiChunk {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
  error?: { code?: number; message?: string; status?: string }
}

export class GeminiApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'GeminiApiError'
  }
}

// --- request translation -------------------------------------------------

function systemText(system: AnthropicParams['system']): string | undefined {
  if (!system) return undefined
  if (typeof system === 'string') return system
  return system
    .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
    .filter(Boolean)
    .join('\n\n')
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c: Block) => (c?.type === 'text' ? c.text : JSON.stringify(c)))
      .join('\n')
  }
  return content == null ? '' : JSON.stringify(content)
}

export function toGeminiContents(messages: AnthropicParams['messages']) {
  // tool_result blocks reference tool_use ids; Gemini wants the function name.
  const toolNames = new Map<string, string>()
  const contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> = []

  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'model' : 'user'
    const blocks: Block[] =
      typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content
    const parts: GeminiPart[] = []

    let firstCallInMessage = true
    for (const b of blocks) {
      switch (b?.type) {
        case 'text':
          if (b.text) parts.push({ text: b.text })
          break
        case 'image':
        case 'document':
          if (b.source?.type === 'base64') {
            parts.push({ inline_data: { mime_type: b.source.media_type, data: b.source.data } })
          } else if (b.source?.type === 'text' && typeof b.source.data === 'string') {
            parts.push({ text: b.source.data })
          }
          break
        case 'tool_use': {
          toolNames.set(b.id, b.name)
          const part: GeminiPart = { functionCall: { name: b.name, args: b.input ?? {} } }
          // Only the first call of a parallel batch carries a signature.
          if (b.gemini_thought_signature) part.thoughtSignature = b.gemini_thought_signature
          else if (firstCallInMessage) part.thoughtSignature = SKIP_SIGNATURE
          firstCallInMessage = false
          parts.push(part)
          break
        }
        case 'tool_result': {
          const name = toolNames.get(b.tool_use_id) ?? 'unknown_tool'
          const text = toolResultText(b.content)
          parts.push({
            functionResponse: {
              name,
              response: b.is_error ? { error: text } : { result: text },
            },
          })
          break
        }
        // thinking / redacted_thinking: Gemini carries reasoning via
        // signatures instead; replaying the text is neither needed nor allowed.
        default:
          break
      }
    }

    if (parts.length === 0) continue
    // Gemini rejects consecutive turns with the same role — merge them.
    const prev = contents[contents.length - 1]
    if (prev && prev.role === role) prev.parts.push(...parts)
    else contents.push({ role, parts })
  }

  return contents
}

function toGeminiModel(model: string | undefined): string {
  // Callers pass Bedrock ids (eu.anthropic.claude-…); only honour Gemini ids.
  return model && model.startsWith('gemini') ? model : geminiAgentModel()
}

export function toGeminiRequest(params: AnthropicParams) {
  const body: Record<string, unknown> = {
    contents: toGeminiContents(params.messages),
    generationConfig: {
      maxOutputTokens: params.max_tokens,
      ...(params.temperature != null ? { temperature: params.temperature } : {}),
      ...(params.thinking?.type === 'enabled'
        ? {
            thinkingConfig: {
              includeThoughts: true,
              ...(params.thinking.budget_tokens ? { thinkingBudget: params.thinking.budget_tokens } : {}),
            },
          }
        : params.thinking?.type === 'adaptive'
          ? {
              thinkingConfig: {
                includeThoughts: true,
                ...(params.output_config?.effort
                  ? { thinkingLevel: THINKING_LEVEL[params.output_config.effort] ?? 'high' }
                  : {}),
              },
            }
          : {}),
    },
  }

  const sys = systemText(params.system)
  if (sys) body.systemInstruction = { parts: [{ text: sys }] }

  if (params.tools && params.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: params.tools.map((t) => ({
          name: t.name,
          description: t.description ?? '',
          parametersJsonSchema: t.input_schema ?? { type: 'object', properties: {} },
        })),
      },
    ]
    const tc = params.tool_choice
    if (tc) {
      body.toolConfig = {
        functionCallingConfig:
          tc.type === 'tool'
            ? { mode: 'ANY', allowedFunctionNames: [tc.name] }
            : { mode: tc.type === 'any' ? 'ANY' : tc.type === 'none' ? 'NONE' : 'AUTO' },
      }
    }
  }

  return body
}

// --- response translation ------------------------------------------------

class MessageAssembler {
  content: Block[] = []
  usage = { input_tokens: 0, output_tokens: 0 }
  finishReason: string | undefined

  constructor(
    private onText: (delta: string) => void,
    private onEvent: (ev: unknown) => void,
  ) {}

  private last(): Block | undefined {
    return this.content[this.content.length - 1]
  }

  push(chunk: GeminiChunk) {
    if (chunk.usageMetadata) {
      this.usage = {
        input_tokens: chunk.usageMetadata.promptTokenCount ?? 0,
        output_tokens:
          (chunk.usageMetadata.candidatesTokenCount ?? 0) + (chunk.usageMetadata.thoughtsTokenCount ?? 0),
      }
    }
    const cand = chunk.candidates?.[0]
    if (cand?.finishReason) this.finishReason = cand.finishReason
    for (const part of cand?.content?.parts ?? []) this.pushPart(part)
  }

  private pushPart(part: GeminiPart) {
    if (part.functionCall) {
      const block = {
        type: 'tool_use',
        id: `toolu_gem_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
        ...(part.thoughtSignature ? { gemini_thought_signature: part.thoughtSignature } : {}),
      }
      this.content.push(block)
      this.onEvent({ type: 'content_block_start', index: this.content.length - 1, content_block: block })
      return
    }

    if (typeof part.text === 'string' && part.text.length > 0) {
      const kind = part.thought ? 'thinking' : 'text'
      const last = this.last()
      if (last && last.type === kind) {
        if (kind === 'thinking') last.thinking += part.text
        else last.text += part.text
      } else {
        this.content.push(kind === 'thinking' ? { type: 'thinking', thinking: part.text, signature: '' } : { type: 'text', text: part.text })
      }
      if (kind === 'thinking') {
        this.onEvent({ type: 'content_block_delta', index: this.content.length - 1, delta: { type: 'thinking_delta', thinking: part.text } })
      } else {
        this.onText(part.text)
      }
    }
  }

  build(model: string): AnthropicLikeMessage {
    const hasToolUse = this.content.some((b) => b.type === 'tool_use')
    return {
      id: `msg_gem_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: this.content,
      stop_reason: hasToolUse ? 'tool_use' : this.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn',
      stop_sequence: null,
      usage: this.usage,
    }
  }
}

async function geminiFetch(model: string, method: string, body: unknown): Promise<Response> {
  const apiKey = process.env.AI_API_KEY
  if (!apiKey) throw new GeminiApiError(401, 'AI_API_KEY is not set')
  const res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 500)
    throw new GeminiApiError(res.status, `Gemini HTTP ${res.status}: ${detail}`)
  }
  return res
}

async function create(params: AnthropicParams): Promise<AnthropicLikeMessage> {
  const model = toGeminiModel(params.model)
  // Prompt-cache prewarm (max_tokens: 1) is an Anthropic-ism; Gemini caches
  // implicitly, so skip the paid round-trip.
  if ((params.max_tokens ?? 0) <= 1) {
    return new MessageAssembler(() => {}, () => {}).build(model)
  }
  const res = await geminiFetch(model, 'generateContent', toGeminiRequest(params))
  const assembler = new MessageAssembler(() => {}, () => {})
  assembler.push((await res.json()) as GeminiChunk)
  return assembler.build(model)
}

type Listener = (arg: any) => void

class GeminiMessageStream {
  private listeners: Record<string, Listener[]> = {}
  private done: Promise<AnthropicLikeMessage>

  constructor(params: AnthropicParams) {
    // Start on the next tick so callers can attach .on() handlers first.
    this.done = Promise.resolve().then(() => this.run(params))
    // Avoid an unhandled rejection if the caller never awaits finalMessage().
    this.done.catch(() => {})
  }

  on(event: string, fn: Listener): this {
    ;(this.listeners[event] ??= []).push(fn)
    return this
  }

  private emit(event: string, arg: unknown) {
    for (const fn of this.listeners[event] ?? []) fn(arg)
  }

  finalMessage(): Promise<AnthropicLikeMessage> {
    return this.done
  }

  private async run(params: AnthropicParams): Promise<AnthropicLikeMessage> {
    const model = toGeminiModel(params.model)
    const res = await geminiFetch(model, 'streamGenerateContent?alt=sse', toGeminiRequest(params))
    const assembler = new MessageAssembler(
      (d) => this.emit('text', d),
      (ev) => this.emit('streamEvent', ev),
    )

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const json = line.slice(5).trim()
        if (!json) continue
        const chunk = JSON.parse(json) as GeminiChunk
        if (chunk.error) throw new GeminiApiError(chunk.error.code ?? 500, chunk.error.message ?? 'Gemini stream error')
        assembler.push(chunk)
      }
    }

    const message = assembler.build(model)
    this.emit('message', message)
    return message
  }
}

export interface GeminiAgentClient {
  messages: {
    create(params: AnthropicParams): Promise<AnthropicLikeMessage>
    stream(params: AnthropicParams): GeminiMessageStream
  }
}

export function createGeminiAgentClient(): GeminiAgentClient {
  return {
    messages: {
      create,
      stream: (params) => new GeminiMessageStream(params),
    },
  }
}

import { describe, it, expect, vi, afterEach } from 'vitest'
import { geminiPdfFetch } from '../services/openai-compatible'

describe('geminiPdfFetch (HT patch)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('rewrites a PDF file part into an image_url data URL and leaves other parts alone', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const pdf = 'data:application/pdf;base64,JVBERi0='
    await geminiPdfFetch('https://example.test', {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'file', file: { file_data: pdf, filename: 'f.pdf' } },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } },
              { type: 'text', text: 'q' },
            ],
          },
        ],
      }),
    })
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(sent.messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: pdf } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } },
      { type: 'text', text: 'q' },
    ])
  })

  it('passes requests without file parts through untouched', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const init = { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hej' }] }) }
    await geminiPdfFetch('https://example.test', init)
    expect(fetchMock).toHaveBeenCalledWith('https://example.test', init)
  })
})

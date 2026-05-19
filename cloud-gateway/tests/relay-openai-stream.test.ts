import assert from 'node:assert/strict'
import test from 'node:test'
import { AccountBalance } from '../src/billing/account-do.js'
import { relayOpenAIResponsesStream } from '../src/routes/openai.js'

const routing = {
  routingRule: {
    id: 'route-1',
    accountGroup: 'default',
    requestedModel: 'gpt-4.1-mini',
    providerTokenId: 'tok-1',
    actualProviderModel: 'gpt-4.1-mini',
    priority: 1,
    weight: 1,
    status: 'active' as const,
  },
  providerToken: {
    id: 'tok-1',
    provider: 'openai',
    adapter: 'openai',
    status: 'active' as const,
    exhaustedUntil: null,
  },
  actualProviderModel: 'gpt-4.1-mini',
}

const priceBook = [
  {
    id: 'price-1',
    version: 1,
    provider: 'openai',
    model: 'gpt-4.1-mini',
    sellInputMicroUsdPer1MTokens: 100_000,
    sellOutputMicroUsdPer1MTokens: 200_000,
    upstreamInputMicroUsdPer1MTokens: 50_000,
    upstreamOutputMicroUsdPer1MTokens: 100_000,
    validFrom: '2026-05-01T00:00:00Z',
    validTo: null,
    enabled: true,
  },
]

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function readAllText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let result = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }
  result += decoder.decode()
  return result
}

test('streaming relay forwards SSE bytes and settles using final usage event', async () => {
  const account = new AccountBalance({ accountId: 'acct-1', balanceMicroUsd: 10_000 })
  const upstreamChunks = [
    'event: response.created\n',
    'data: {"type":"response.created","response":{"id":"resp-1"}}\n\n',
    'event: response.output_text.delta\n',
    'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
    'event: response.completed\n',
    'data: {"type":"response.completed","response":{"id":"resp-1","usage":{"input_tokens":100,"output_tokens":200,"total_tokens":300}}}\n\n',
  ]

  const fetchCalls: Array<{ url: string; body: unknown; accept: string | null }> = []
  const result = await relayOpenAIResponsesStream({
    account,
    apiKeyId: 'key-1',
    requestId: 'req-stream-1',
    body: { model: 'gpt-4.1-mini', input: 'hello', max_output_tokens: 10, stream: true },
    routing,
    upstreamApiKey: 'sk-upstream-secret',
    priceBook,
    now: '2026-05-19T00:00:00Z',
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        accept: new Headers(init?.headers).get('accept'),
      })
      return sseResponse(upstreamChunks)
    },
  })

  assert.equal(result.status, 200)
  assert.equal(result.response.headers.get('content-type'), 'text/event-stream')
  assert.equal(fetchCalls[0].accept, 'text/event-stream')
  assert.equal((fetchCalls[0].body as { stream: boolean }).stream, true)

  const downstreamText = await readAllText(result.response.body!)
  assert.equal(downstreamText, upstreamChunks.join(''))

  const final = await result.finalize()
  assert.equal(final.settledWithEstimate, false)
  assert.deepEqual(final.usage, { inputTokens: 100, outputTokens: 200, totalTokens: 300 })
  assert.equal(final.log.sellCostMicroUsd, 50)
  assert.equal(account.snapshot().balanceMicroUsd, 9_950)
  assert.equal(account.snapshot().reservedMicroUsd, 0)
})

test('streaming relay fails closed and settles with the reservation estimate when no usage event is emitted', async () => {
  const account = new AccountBalance({ accountId: 'acct-2', balanceMicroUsd: 10_000 })
  const upstreamChunks = [
    'event: response.created\n',
    'data: {"type":"response.created","response":{"id":"resp-2"}}\n\n',
    'event: response.output_text.delta\n',
    'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
  ]

  const result = await relayOpenAIResponsesStream({
    account,
    apiKeyId: 'key-2',
    requestId: 'req-stream-2',
    body: { model: 'gpt-4.1-mini', input: 'hello', max_output_tokens: 10, stream: true },
    routing,
    upstreamApiKey: 'sk-upstream-secret',
    priceBook,
    now: '2026-05-19T00:00:00Z',
    fetchImpl: async () => sseResponse(upstreamChunks),
  })

  await readAllText(result.response.body!)
  const final = await result.finalize()

  assert.equal(final.settledWithEstimate, true)
  assert.equal(final.usage, null)
  assert.equal(final.log.errorCode, 'usage_unavailable')
  assert.ok(final.log.sellCostMicroUsd! > 0)
  assert.equal(account.snapshot().reservedMicroUsd, 0)
  assert.equal(account.snapshot().balanceMicroUsd, 10_000 - final.log.sellCostMicroUsd!)
})

test('streaming relay refunds the reservation and throws when upstream returns a non-2xx status', async () => {
  const account = new AccountBalance({ accountId: 'acct-3', balanceMicroUsd: 10_000 })

  await assert.rejects(
    relayOpenAIResponsesStream({
      account,
      apiKeyId: 'key-3',
      requestId: 'req-stream-3',
      body: { model: 'gpt-4.1-mini', input: 'hello', max_output_tokens: 10, stream: true },
      routing,
      upstreamApiKey: 'sk-upstream-secret',
      priceBook,
      now: '2026-05-19T00:00:00Z',
      fetchImpl: async () =>
        new Response('{"error":"upstream_failed"}', {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    }),
    (error: unknown) => {
      assert.ok(error && typeof error === 'object' && 'code' in error)
      assert.equal((error as { code: string }).code, 'provider_http_503')
      return true
    }
  )

  assert.equal(account.snapshot().reservedMicroUsd, 0)
  assert.equal(account.snapshot().balanceMicroUsd, 10_000)
})

test('streaming relay reassembles SSE events split across chunk boundaries', async () => {
  const account = new AccountBalance({ accountId: 'acct-4', balanceMicroUsd: 10_000 })
  const upstreamChunks = [
    'event: response.compl',
    'eted\ndata: {"type":"response.completed","response":{"id":"resp-4","usage":{"in',
    'put_tokens":50,"output_tokens":75,"total_tokens":125}}}\n\n',
  ]

  const result = await relayOpenAIResponsesStream({
    account,
    apiKeyId: 'key-4',
    requestId: 'req-stream-4',
    body: { model: 'gpt-4.1-mini', input: 'hello', max_output_tokens: 10, stream: true },
    routing,
    upstreamApiKey: 'sk-upstream-secret',
    priceBook,
    now: '2026-05-19T00:00:00Z',
    fetchImpl: async () => sseResponse(upstreamChunks),
  })

  const downstream = await readAllText(result.response.body!)
  assert.equal(downstream, upstreamChunks.join(''))

  const final = await result.finalize()
  assert.equal(final.settledWithEstimate, false)
  assert.deepEqual(final.usage, { inputTokens: 50, outputTokens: 75, totalTokens: 125 })
})

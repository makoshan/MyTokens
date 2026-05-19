import assert from 'node:assert/strict'
import test from 'node:test'
import { AccountBalance } from '../src/billing/account-do.js'
import { anthropicAdapter } from '../src/providers/anthropic.js'
import { relayCompletion, relayCompletionStream } from '../src/routes/relay.js'

const routing = {
  routingRule: {
    id: 'route-anth-1',
    accountGroup: 'default',
    requestedModel: 'claude-3-5-sonnet',
    providerTokenId: 'tok-anth-1',
    actualProviderModel: 'claude-3-5-sonnet',
    priority: 1,
    weight: 1,
    status: 'active' as const,
  },
  providerToken: {
    id: 'tok-anth-1',
    provider: 'anthropic',
    adapter: 'anthropic',
    status: 'active' as const,
    exhaustedUntil: null,
  },
  actualProviderModel: 'claude-3-5-sonnet',
}

const priceBook = [
  {
    id: 'price-anth-1',
    version: 1,
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    sellInputMicroUsdPer1MTokens: 3_000_000,
    sellOutputMicroUsdPer1MTokens: 15_000_000,
    upstreamInputMicroUsdPer1MTokens: 3_000_000,
    upstreamOutputMicroUsdPer1MTokens: 15_000_000,
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

test('Anthropic relay calls /v1/messages with x-api-key and settles from non-stream usage', async () => {
  const account = new AccountBalance({ accountId: 'acct-1', balanceMicroUsd: 1_000_000 })
  const calls: Array<{ url: string; xApiKey: string | null; version: string | null; body: Record<string, unknown> }> = []

  const result = await relayCompletion(anthropicAdapter, {
    account,
    apiKeyId: 'key-1',
    requestId: 'req-anth-1',
    body: {
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 32,
    },
    routing,
    upstreamApiKey: 'sk-ant-secret',
    priceBook,
    now: '2026-05-19T00:00:00Z',
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({
        url: String(url),
        xApiKey: headers.get('x-api-key'),
        version: headers.get('anthropic-version'),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-3-5-sonnet',
          content: [{ type: 'text', text: 'hi back' }],
          usage: { input_tokens: 40, output_tokens: 25 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    },
  })

  assert.equal(result.status, 200)
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages')
  assert.equal(calls[0].xApiKey, 'sk-ant-secret')
  assert.equal(calls[0].version, '2023-06-01')
  assert.equal(calls[0].body.model, 'claude-3-5-sonnet')
  assert.equal(result.log.endpoint, '/v1/messages')
  assert.equal(result.log.inputTokens, 40)
  assert.equal(result.log.outputTokens, 25)
  // 40 input * 3 + 25 output * 15 = 120 + 375 = 495 micro-USD
  assert.equal(result.log.sellCostMicroUsd, 495)
  assert.equal(account.snapshot().balanceMicroUsd, 1_000_000 - 495)
})

test('Anthropic streaming relay merges input_tokens from message_start and output_tokens from message_delta', async () => {
  const account = new AccountBalance({ accountId: 'acct-2', balanceMicroUsd: 1_000_000 })
  const upstreamChunks = [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_2","model":"claude-3-5-sonnet","usage":{"input_tokens":50,"output_tokens":0}}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    'event: message_delta\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":30}}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n',
  ]

  const result = await relayCompletionStream(anthropicAdapter, {
    account,
    apiKeyId: 'key-2',
    requestId: 'req-anth-stream-1',
    body: {
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 32,
      stream: true,
    },
    routing,
    upstreamApiKey: 'sk-ant-secret',
    priceBook,
    now: '2026-05-19T00:00:00Z',
    fetchImpl: async () => sseResponse(upstreamChunks),
  })

  assert.equal(result.status, 200)
  const downstreamText = await readAllText(result.response.body!)
  assert.equal(downstreamText, upstreamChunks.join(''))

  const final = await result.finalize()
  assert.equal(final.settledWithEstimate, false)
  assert.deepEqual(final.usage, { inputTokens: 50, outputTokens: 30, totalTokens: 80 })
  // 50 * 3 + 30 * 15 = 150 + 450 = 600
  assert.equal(final.log.sellCostMicroUsd, 600)
  assert.equal(final.log.endpoint, '/v1/messages')
  assert.equal(account.snapshot().balanceMicroUsd, 1_000_000 - 600)
})

test('Anthropic streaming relay fails closed when only one half of usage is reported', async () => {
  const account = new AccountBalance({ accountId: 'acct-3', balanceMicroUsd: 1_000_000 })
  const upstreamChunks = [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_3","usage":{"input_tokens":12,"output_tokens":0}}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
  ]

  const result = await relayCompletionStream(anthropicAdapter, {
    account,
    apiKeyId: 'key-3',
    requestId: 'req-anth-stream-2',
    body: {
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 32,
      stream: true,
    },
    routing,
    upstreamApiKey: 'sk-ant-secret',
    priceBook,
    now: '2026-05-19T00:00:00Z',
    fetchImpl: async () => sseResponse(upstreamChunks),
  })

  await readAllText(result.response.body!)
  const final = await result.finalize()

  assert.equal(final.settledWithEstimate, true)
  assert.equal(final.log.errorCode, 'usage_unavailable')
  assert.ok(final.log.sellCostMicroUsd! > 0)
})

test('Anthropic relay refunds the reservation and throws when upstream returns non-2xx', async () => {
  const account = new AccountBalance({ accountId: 'acct-4', balanceMicroUsd: 1_000_000 })

  await assert.rejects(
    relayCompletion(anthropicAdapter, {
      account,
      apiKeyId: 'key-4',
      requestId: 'req-anth-err',
      body: {
        model: 'claude-3-5-sonnet',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 32,
      },
      routing,
      upstreamApiKey: 'sk-ant-secret',
      priceBook,
      now: '2026-05-19T00:00:00Z',
      fetchImpl: async () =>
        new Response('{"error":{"type":"overloaded_error"}}', {
          status: 529,
          headers: { 'content-type': 'application/json' },
        }),
    }),
    (error: unknown) => {
      assert.ok(error && typeof error === 'object' && 'code' in error)
      assert.equal((error as { code: string }).code, 'provider_http_529')
      return true
    }
  )

  assert.equal(account.snapshot().reservedMicroUsd, 0)
  assert.equal(account.snapshot().balanceMicroUsd, 1_000_000)
})

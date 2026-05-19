import type { PartialProviderUsage, ProviderAdapter, ProviderUsage } from './adapter.js'

const ANTHROPIC_VERSION = '2023-06-01'

function roughInputTokens(body: Record<string, unknown>): number {
  const messages = body.messages ?? body.system ?? body.prompt ?? ''
  return Math.max(1, Math.ceil(JSON.stringify(messages).length / 4))
}

function maxOutputTokens(body: Record<string, unknown>): number {
  const value = body.max_tokens
  return Math.max(1, Number(value) || 1024)
}

function readUsageRecord(value: unknown, fields: { input?: boolean; output?: boolean }): PartialProviderUsage | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const partial: PartialProviderUsage = {}
  if (fields.input && record.input_tokens !== undefined) {
    partial.inputTokens = Number(record.input_tokens)
  }
  if (fields.output && record.output_tokens !== undefined) {
    partial.outputTokens = Number(record.output_tokens)
  }
  return partial.inputTokens === undefined && partial.outputTokens === undefined ? null : partial
}

function parseEventDataLines(eventBlock: string): unknown | null {
  const dataLines: string[] = []
  for (const rawLine of eventBlock.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  if (dataLines.length === 0) return null
  const payload = dataLines.join('\n')
  if (payload === '[DONE]') return null
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

export function parseAnthropicUsage(payload: unknown): ProviderUsage {
  const usage =
    typeof payload === 'object' && payload !== null
      ? (payload as { usage?: Record<string, unknown> }).usage
      : undefined
  const inputTokens = Number(usage?.input_tokens ?? 0)
  const outputTokens = Number(usage?.output_tokens ?? 0)
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

export function parseAnthropicStreamEventUsage(eventBlock: string): PartialProviderUsage | null {
  const parsed = parseEventDataLines(eventBlock)
  if (!parsed || typeof parsed !== 'object') return null
  const root = parsed as Record<string, unknown>
  const type = typeof root.type === 'string' ? root.type : ''
  if (type === 'message_start') {
    const message = root.message as Record<string, unknown> | undefined
    return readUsageRecord(message?.usage, { input: true })
  }
  if (type === 'message_delta') {
    return readUsageRecord(root.usage, { output: true })
  }
  return null
}

export const anthropicAdapter: ProviderAdapter = {
  name: 'anthropic',
  endpoint: '/v1/messages',
  buildUpstreamRequest({ body, model, upstreamApiKey, stream }) {
    const upstreamBody: Record<string, unknown> = { ...body, model }
    if (stream) upstreamBody.stream = true
    if (upstreamBody.max_tokens === undefined) upstreamBody.max_tokens = 1024
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'x-api-key': upstreamApiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
        ...(stream ? { accept: 'text/event-stream' } : {}),
      },
      body: JSON.stringify(upstreamBody),
    }
  },
  estimateInputTokens(body) {
    return roughInputTokens(body)
  },
  estimateMaxOutputTokens(body) {
    return maxOutputTokens(body)
  },
  parseUsage(payload) {
    return parseAnthropicUsage(payload)
  },
  parseStreamEventUsage(eventBlock) {
    return parseAnthropicStreamEventUsage(eventBlock)
  },
}

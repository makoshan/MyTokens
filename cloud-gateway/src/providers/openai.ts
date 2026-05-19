import type { PartialProviderUsage, ProviderAdapter, ProviderUsage } from './adapter.js'

export type OpenAIUsage = ProviderUsage

export function parseOpenAIUsage(payload: unknown): OpenAIUsage {
  const usage =
    typeof payload === 'object' && payload !== null
      ? (payload as { usage?: Record<string, unknown> }).usage
      : undefined
  const inputTokens = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0)
  const outputTokens = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0)
  const totalTokens = Number(usage?.total_tokens ?? inputTokens + outputTokens)
  return { inputTokens, outputTokens, totalTokens }
}

function usageFromObject(value: unknown): PartialProviderUsage | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (
    record.input_tokens === undefined &&
    record.output_tokens === undefined &&
    record.prompt_tokens === undefined &&
    record.completion_tokens === undefined &&
    record.total_tokens === undefined
  ) {
    return null
  }
  const result: PartialProviderUsage = {}
  if (record.input_tokens !== undefined || record.prompt_tokens !== undefined) {
    result.inputTokens = Number(record.input_tokens ?? record.prompt_tokens)
  }
  if (record.output_tokens !== undefined || record.completion_tokens !== undefined) {
    result.outputTokens = Number(record.output_tokens ?? record.completion_tokens)
  }
  if (record.total_tokens !== undefined) {
    result.totalTokens = Number(record.total_tokens)
  }
  return result
}

export function parseOpenAIStreamEventUsage(eventBlock: string): PartialProviderUsage | null {
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
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const root = parsed as Record<string, unknown>
  const response = (root.response ?? null) as Record<string, unknown> | null
  return usageFromObject(root.usage) ?? usageFromObject(response?.usage) ?? null
}

export function normalizeProviderError(status: number, payload: unknown): { status: number; code: string; message: string } {
  const maybeError =
    typeof payload === 'object' && payload !== null ? (payload as { error?: { code?: string; message?: string } }).error : undefined
  return {
    status,
    code: maybeError?.code ?? `provider_http_${status}`,
    message: maybeError?.message ?? `Provider returned HTTP ${status}`,
  }
}

function roughInputTokens(body: Record<string, unknown>): number {
  const input = body.input ?? body.messages ?? ''
  return Math.max(1, Math.ceil(JSON.stringify(input).length / 4))
}

function maxOutputTokens(body: Record<string, unknown>): number {
  const value = body.max_output_tokens ?? body.max_tokens ?? 256
  return Math.max(1, Number(value) || 256)
}

export const openAIAdapter: ProviderAdapter = {
  name: 'openai',
  endpoint: '/v1/responses',
  buildUpstreamRequest({ body, model, upstreamApiKey, stream }) {
    const upstreamBody: Record<string, unknown> = { ...body, model }
    if (stream) upstreamBody.stream = true
    return {
      url: 'https://api.openai.com/v1/responses',
      headers: {
        authorization: `Bearer ${upstreamApiKey}`,
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
    return parseOpenAIUsage(payload)
  },
  parseStreamEventUsage(eventBlock) {
    return parseOpenAIStreamEventUsage(eventBlock)
  },
}

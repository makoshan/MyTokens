export interface OpenAIUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export function parseOpenAIUsage(payload: unknown): OpenAIUsage {
  const usage = typeof payload === 'object' && payload !== null ? (payload as { usage?: Record<string, unknown> }).usage : undefined
  const inputTokens = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0)
  const outputTokens = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0)
  const totalTokens = Number(usage?.total_tokens ?? inputTokens + outputTokens)
  return { inputTokens, outputTokens, totalTokens }
}

function usageFromObject(value: unknown): OpenAIUsage | null {
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
  const inputTokens = Number(record.input_tokens ?? record.prompt_tokens ?? 0)
  const outputTokens = Number(record.output_tokens ?? record.completion_tokens ?? 0)
  const totalTokens = Number(record.total_tokens ?? inputTokens + outputTokens)
  return { inputTokens, outputTokens, totalTokens }
}

export function parseOpenAIStreamEventUsage(eventBlock: string): OpenAIUsage | null {
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

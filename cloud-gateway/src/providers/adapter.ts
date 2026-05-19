export interface ProviderUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export type PartialProviderUsage = Partial<ProviderUsage>

export interface AdapterUpstreamRequest {
  url: string
  headers: Record<string, string>
  body: string
}

export interface ProviderAdapter {
  /** Logical adapter name. Must match ProviderTokenRecord.adapter values. */
  readonly name: string
  /** OpenAI-compatible inbound path this adapter serves (e.g. /v1/responses). */
  readonly endpoint: string

  buildUpstreamRequest(input: {
    body: Record<string, unknown>
    model: string
    upstreamApiKey: string
    stream: boolean
  }): AdapterUpstreamRequest

  estimateInputTokens(body: Record<string, unknown>): number
  estimateMaxOutputTokens(body: Record<string, unknown>): number

  parseUsage(payload: unknown): ProviderUsage
  parseStreamEventUsage(eventBlock: string): PartialProviderUsage | null
}

export function mergeUsage(into: PartialProviderUsage, next: PartialProviderUsage): PartialProviderUsage {
  return {
    inputTokens: next.inputTokens ?? into.inputTokens,
    outputTokens: next.outputTokens ?? into.outputTokens,
    totalTokens: next.totalTokens ?? into.totalTokens,
  }
}

export function finalizeUsage(partial: PartialProviderUsage): ProviderUsage | null {
  if (partial.inputTokens == null || partial.outputTokens == null) return null
  const inputTokens = partial.inputTokens
  const outputTokens = partial.outputTokens
  const totalTokens = partial.totalTokens ?? inputTokens + outputTokens
  return { inputTokens, outputTokens, totalTokens }
}

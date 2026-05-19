export type QualityLabel = 'trusted' | 'mostly reliable' | 'degraded' | 'suspicious'

export function evaluateModelQuality(input: {
  protocolConsistent: boolean
  identityConsistent: boolean
  responseStructureValid: boolean
  latencyMs: number
  tokensPerSecond: number
  recentErrorRate: number
}): { label: QualityLabel; score: number; reasons: string[] } {
  let score = 100
  const reasons: string[] = []

  if (!input.protocolConsistent) {
    score -= 35
    reasons.push('protocol_mismatch')
  }
  if (!input.identityConsistent) {
    score -= 30
    reasons.push('identity_mismatch')
  }
  if (!input.responseStructureValid) {
    score -= 20
    reasons.push('invalid_response_structure')
  }
  if (input.latencyMs > 5_000) {
    score -= 15
    reasons.push('high_latency')
  }
  if (input.tokensPerSecond < 8) {
    score -= 15
    reasons.push('low_throughput')
  }
  if (input.recentErrorRate > 0.1) {
    score -= 25
    reasons.push('high_error_rate')
  }

  const bounded = Math.max(0, score)
  const label: QualityLabel =
    bounded >= 85 ? 'trusted' : bounded >= 70 ? 'mostly reliable' : bounded >= 45 ? 'degraded' : 'suspicious'

  return { label, score: bounded, reasons }
}

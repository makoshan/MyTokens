import { GatewayError } from '../errors.js'
import type { PriceBookRow } from '../types.js'

function ceilDiv(numerator: number, denominator: number): number {
  return Math.ceil(numerator / denominator)
}

export function findPriceRow(input: {
  priceBook: PriceBookRow[]
  provider: string
  model: string
  at: string
}): PriceBookRow {
  const atMs = Date.parse(input.at)
  const row = input.priceBook
    .filter((candidate) => {
      if (!candidate.enabled) return false
      if (candidate.provider !== input.provider || candidate.model !== input.model) return false
      if (Date.parse(candidate.validFrom) > atMs) return false
      if (candidate.validTo && Date.parse(candidate.validTo) <= atMs) return false
      return true
    })
    .sort((a, b) => b.version - a.version)[0]

  if (!row) throw new GatewayError('unknown_model_price', 400)
  return row
}

export function priceUsage(input: {
  priceBook: PriceBookRow[]
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  at: string
}) {
  const row = findPriceRow(input)
  const sellCostMicroUsd =
    ceilDiv(input.inputTokens * row.sellInputMicroUsdPer1MTokens, 1_000_000) +
    ceilDiv(input.outputTokens * row.sellOutputMicroUsdPer1MTokens, 1_000_000)
  const upstreamCostMicroUsd =
    ceilDiv(input.inputTokens * row.upstreamInputMicroUsdPer1MTokens, 1_000_000) +
    ceilDiv(input.outputTokens * row.upstreamOutputMicroUsdPer1MTokens, 1_000_000)

  return { sellCostMicroUsd, upstreamCostMicroUsd, priceVersion: row.version }
}

export function estimateReservation(input: {
  inputTokens: number
  maxOutputTokens: number
  inputMicroUsdPer1MTokens: number
  outputMicroUsdPer1MTokens: number
  minimumReserveMicroUsd: number
}) {
  const estimated =
    ceilDiv(input.inputTokens * input.inputMicroUsdPer1MTokens, 1_000_000) +
    ceilDiv(input.maxOutputTokens * input.outputMicroUsdPer1MTokens, 1_000_000)
  return { estimatedMicroUsd: Math.max(estimated, input.minimumReserveMicroUsd) }
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { estimateReservation, priceUsage } from '../src/billing/pricing.js'

test('pricing uses versioned integer micro USD rows without floating point drift', () => {
  const priceBook = [
    {
      id: 'price-1',
      version: 1,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      sellInputMicroUsdPer1MTokens: 150_000,
      sellOutputMicroUsdPer1MTokens: 600_000,
      upstreamInputMicroUsdPer1MTokens: 100_000,
      upstreamOutputMicroUsdPer1MTokens: 400_000,
      validFrom: '2026-05-01T00:00:00Z',
      validTo: null,
      enabled: true,
    },
  ]

  const cost = priceUsage({
    priceBook,
    provider: 'openai',
    model: 'gpt-4.1-mini',
    inputTokens: 1_000,
    outputTokens: 2_000,
    at: '2026-05-19T00:00:00Z',
  })

  assert.equal(cost.sellCostMicroUsd, 1_350)
  assert.equal(cost.upstreamCostMicroUsd, 900)
  assert.equal(cost.priceVersion, 1)
})

test('reservation estimates output exposure and enforces a minimum hold', () => {
  const estimate = estimateReservation({
    inputTokens: 12,
    maxOutputTokens: 20,
    inputMicroUsdPer1MTokens: 100_000,
    outputMicroUsdPer1MTokens: 200_000,
    minimumReserveMicroUsd: 100,
  })

  assert.equal(estimate.estimatedMicroUsd, 100)
})

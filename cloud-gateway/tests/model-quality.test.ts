import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateModelQuality } from '../src/quality/model-quality.js'

test('model quality labels combine protocol, identity, latency, and error signals', () => {
  assert.equal(
    evaluateModelQuality({
      protocolConsistent: true,
      identityConsistent: true,
      responseStructureValid: true,
      latencyMs: 800,
      tokensPerSecond: 42,
      recentErrorRate: 0.01,
    }).label,
    'trusted'
  )

  assert.equal(
    evaluateModelQuality({
      protocolConsistent: false,
      identityConsistent: false,
      responseStructureValid: true,
      latencyMs: 9_000,
      tokensPerSecond: 3,
      recentErrorRate: 0.25,
    }).label,
    'suspicious'
  )
})

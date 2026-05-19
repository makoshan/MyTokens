import assert from 'node:assert/strict'
import test from 'node:test'
import { decryptProviderToken, encryptProviderToken, updateProviderTokenHealth } from '../src/vault/provider-tokens.js'

test('provider token vault stores ciphertext and decrypts only with the active master key', async () => {
  const masterKeys = { v1: new Uint8Array(32).fill(1) }
  const record = await encryptProviderToken({
    id: 'tok-1',
    provider: 'openai',
    label: 'primary',
    adapter: 'openai',
    plaintext: 'sk-upstream-secret',
    masterKeys,
    keyVersion: 'v1',
  })

  assert.equal(record.keyVersion, 'v1')
  assert.notEqual(record.ciphertext, 'sk-upstream-secret')
  assert.equal(record.status, 'active')

  const plaintext = await decryptProviderToken(record, masterKeys)
  assert.equal(plaintext, 'sk-upstream-secret')
})

test('provider token health marks quota and auth errors as unavailable', () => {
  const token = {
    id: 'tok-1',
    provider: 'openai',
    adapter: 'openai',
    status: 'active' as const,
    exhaustedUntil: null,
    successCount: 0,
    failureCount: 0,
  }

  const updated = updateProviderTokenHealth({
    token,
    statusCode: 429,
    latencyMs: 1200,
    now: '2026-05-19T00:00:00Z',
  })

  assert.equal(updated.status, 'active')
  assert.equal(updated.failureCount, 1)
  assert.equal(updated.lastResponseMs, 1200)
  assert.equal(updated.exhaustedUntil, '2026-05-19T00:05:00.000Z')
})

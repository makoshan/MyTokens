import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createApiKey,
  hashApiKey,
  registerApiKey,
  verifyApiKey,
} from '../src/auth/api-keys.js'

test('API keys are generated with a MyKey prefix and verified by HMAC hash only', async () => {
  const pepper = 'test-pepper'
  const key = createApiKey({ environment: 'test', randomBytes: new Uint8Array(32).fill(7) })
  const registry = [
    registerApiKey({
      id: 'key-1',
      accountId: 'acct-1',
      rawKey: key.rawKey,
      pepper,
      now: '2026-05-19T00:00:00Z',
    }),
  ]

  assert.match(key.rawKey, /^sk-mykey_test_/)
  assert.equal(registry[0].keyPrefix, 'sk-mykey_test')
  assert.equal(registry[0].keyLast4, key.rawKey.slice(-4))
  assert.notEqual(registry[0].keyHash, key.rawKey)
  assert.equal(hashApiKey(key.rawKey, pepper), registry[0].keyHash)

  const result = await verifyApiKey({
    authorizationHeader: `Bearer ${key.rawKey}`,
    pepper,
    findByHash: async (hash) => registry.find((row) => row.keyHash === hash) ?? null,
  })

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.accountId, 'acct-1')
})

test('revoked and malformed API keys are rejected', async () => {
  const pepper = 'test-pepper'
  const key = createApiKey({ environment: 'live', randomBytes: new Uint8Array(32).fill(9) })
  const revoked = {
    ...registerApiKey({
      id: 'key-2',
      accountId: 'acct-2',
      rawKey: key.rawKey,
      pepper,
      now: '2026-05-19T00:00:00Z',
    }),
    status: 'revoked' as const,
  }

  const revokedResult = await verifyApiKey({
    authorizationHeader: `Bearer ${key.rawKey}`,
    pepper,
    findByHash: async () => revoked,
  })
  const malformedResult = await verifyApiKey({
    authorizationHeader: 'not-a-bearer-token',
    pepper,
    findByHash: async () => null,
  })

  assert.deepEqual(revokedResult, { ok: false, reason: 'revoked' })
  assert.deepEqual(malformedResult, { ok: false, reason: 'malformed' })
})

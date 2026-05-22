import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  CRYPTO_SCAN_TTL_MS,
  emptyCryptoWalletCache,
  isAccountScanFresh,
  parseCryptoWalletCache,
  pruneCryptoWalletCache,
  type CryptoWalletCache,
} from '../src/utils/cryptoWalletCache'

function sampleCache(): CryptoWalletCache {
  return {
    logoByToken: { 't1': ['https://logo/1.png'], 't2': ['https://logo/2.png'] },
    valueByToken: { 't1': '12.5', 't2': '3.0' },
    trustWalletStatusByToken: { 't1': 'verified', 't2': 'missing' },
    totalUsdByAccount: { 'a1': '$15.50', 'a2': '$0' },
    scannedAtByAccount: { 'a1': 1_000, 'a2': 2_000 },
  }
}

test('parseCryptoWalletCache: null / empty / malformed all yield an empty cache', () => {
  const empty = emptyCryptoWalletCache()
  assert.deepEqual(parseCryptoWalletCache(null), empty)
  assert.deepEqual(parseCryptoWalletCache(''), empty)
  assert.deepEqual(parseCryptoWalletCache('not json {'), empty)
})

test('parseCryptoWalletCache: round-trips a valid payload and ignores junk fields', () => {
  const cache = sampleCache()
  const parsed = parseCryptoWalletCache(JSON.stringify({ ...cache, junk: 42 }))
  assert.deepEqual(parsed, cache)
})

test('parseCryptoWalletCache: coerces non-object / array fields to empty records', () => {
  const parsed = parseCryptoWalletCache(
    JSON.stringify({ logoByToken: [1, 2], valueByToken: 'nope', scannedAtByAccount: null })
  )
  assert.deepEqual(parsed, emptyCryptoWalletCache())
})

test('pruneCryptoWalletCache: drops entries for tokens/accounts that no longer exist', () => {
  const pruned = pruneCryptoWalletCache(sampleCache(), new Set(['t1']), new Set(['a2']))
  assert.deepEqual(pruned, {
    logoByToken: { 't1': ['https://logo/1.png'] },
    valueByToken: { 't1': '12.5' },
    trustWalletStatusByToken: { 't1': 'verified' },
    totalUsdByAccount: { 'a2': '$0' },
    scannedAtByAccount: { 'a2': 2_000 },
  })
})

test('pruneCryptoWalletCache: empty live sets clear everything', () => {
  const pruned = pruneCryptoWalletCache(sampleCache(), new Set(), new Set())
  assert.deepEqual(pruned, emptyCryptoWalletCache())
})

test('isAccountScanFresh: true within the TTL, false past it', () => {
  const cache = sampleCache()
  // a1 scanned at t=1000; "now" 1ms later is fresh, well past the TTL is stale.
  assert.equal(isAccountScanFresh(cache, 'a1', CRYPTO_SCAN_TTL_MS, 1_001), true)
  assert.equal(isAccountScanFresh(cache, 'a1', CRYPTO_SCAN_TTL_MS, 1_000 + CRYPTO_SCAN_TTL_MS + 1), false)
})

test('isAccountScanFresh: false at exactly the TTL boundary and for never-scanned accounts', () => {
  const cache = sampleCache()
  assert.equal(isAccountScanFresh(cache, 'a1', CRYPTO_SCAN_TTL_MS, 1_000 + CRYPTO_SCAN_TTL_MS), false)
  assert.equal(isAccountScanFresh(cache, 'unknown', CRYPTO_SCAN_TTL_MS, 1_000), false)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { redpacketReward, humanError, TOKENS_PER_MYC } from '../src/redpacketRewards.js'

test('redpacketReward derives the dollar value and token estimate shown after a claim', () => {
  const r = redpacketReward(20)
  assert.equal(r.usd, 20) // 1 MYC = $1
  assert.equal(r.tokens, 20 * TOKENS_PER_MYC)
  assert.equal(r.tokens, 13_400_000)
  // The overlay shows "{tokensWanLabel} 万 tokens" → "1,340 万" for 20 MYC.
  assert.equal(r.tokensWanLabel, (13_400_000 / 10000).toLocaleString())
})

test('redpacketReward rounds fractional MYC amounts (e.g. a $14.99 packet)', () => {
  const r = redpacketReward(14.99)
  assert.equal(r.usd, 14.99)
  assert.equal(r.tokens, Math.round(14.99 * TOKENS_PER_MYC))
})

test('humanError maps known backend/wallet codes to friendly buyer copy', () => {
  assert.equal(humanError(new Error('redpacket_already_claimed')), '这个红包已经被领过了')
  assert.equal(humanError(new Error('relayer_pool_insufficient')), '红包池不足，联系发红包的人')
  assert.equal(humanError(new Error('prf_unsupported')), '这个 passkey 不支持 PRF（换个浏览器/设备）')
  assert.equal(humanError(new Error('passkey_create_cancelled')), '已取消')
})

test('humanError passes unknown messages through and stringifies non-Errors', () => {
  assert.equal(humanError(new Error('some_unmapped_500')), 'some_unmapped_500')
  assert.equal(humanError('plain string'), 'plain string')
})

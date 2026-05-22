import assert from 'node:assert/strict'
import test from 'node:test'
import { AccountBalance } from '../src/billing/account-do.js'

test('account balance reserves, settles, and refunds in integer micro USD', () => {
  const account = new AccountBalance({ accountId: 'acct-1', balanceMicroUsd: 10_000 })

  const reservation = account.reserve({
    reservationId: 'res-1',
    requestId: 'req-1',
    estimatedMicroUsd: 3_000,
    provider: 'openai',
    model: 'gpt-4.1-mini',
  })
  assert.equal(reservation.status, 'open')
  assert.equal(account.snapshot().availableMicroUsd, 7_000)

  const settled = account.settle({
    reservationId: 'res-1',
    actualMicroUsd: 2_500,
    idempotencyKey: 'settle-1',
  })
  assert.equal(settled.amountMicroUsd, -2_500)
  assert.equal(account.snapshot().balanceMicroUsd, 7_500)
  assert.equal(account.snapshot().reservedMicroUsd, 0)

  const replay = account.settle({
    reservationId: 'res-1',
    actualMicroUsd: 2_500,
    idempotencyKey: 'settle-1',
  })
  assert.deepEqual(replay, settled)
  assert.equal(account.snapshot().balanceMicroUsd, 7_500)
})

test('insufficient balance and paused accounts fail before upstream calls', () => {
  const account = new AccountBalance({ accountId: 'acct-2', balanceMicroUsd: 1_000 })

  assert.throws(
    () =>
      account.reserve({
        reservationId: 'res-2',
        requestId: 'req-2',
        estimatedMicroUsd: 1_001,
        provider: 'openai',
        model: 'gpt-4.1-mini',
      }),
    /insufficient_balance/
  )

  account.pause()
  assert.throws(
    () =>
      account.reserve({
        reservationId: 'res-3',
        requestId: 'req-3',
        estimatedMicroUsd: 1,
        provider: 'openai',
        model: 'gpt-4.1-mini',
      }),
    /account_paused/
  )
})

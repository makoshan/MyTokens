import assert from 'node:assert/strict'
import test from 'node:test'
import { AccountBalance } from '../src/billing/account-do.js'
import { AccountDurableObject } from '../src/billing/account-do-class.js'
import type { DurableObjectState } from '../src/billing/cloudflare-types.js'
import { DurableObjectAccountActor } from '../src/billing/do-account-actor.js'

function makeState(): DurableObjectState {
  const map = new Map<string, unknown>()
  let alarmAt: number | null = null
  return {
    id: { toString: () => 'stub' },
    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        return map.get(key) as T | undefined
      },
      async put<T>(key: string, value: T): Promise<void> {
        map.set(key, JSON.parse(JSON.stringify(value)))
      },
      async delete(key: string): Promise<boolean> {
        return map.delete(key)
      },
      async setAlarm(scheduledTimeMs: number | Date): Promise<void> {
        alarmAt = typeof scheduledTimeMs === 'number' ? scheduledTimeMs : scheduledTimeMs.getTime()
      },
      async getAlarm(): Promise<number | null> {
        return alarmAt
      },
      async deleteAlarm(): Promise<void> {
        alarmAt = null
      },
    },
    blockConcurrencyWhile: async (cb) => cb(),
  }
}

test('DurableObjectAccountActor speaks the RPC contract: reserve → settle → snapshot returns final balance', async () => {
  const durable = new AccountDurableObject(makeState(), {})
  const actor = new DurableObjectAccountActor({
    stub: { fetch: (input, init) => durable.fetch(input instanceof Request ? input : new Request(input, init)) },
    accountId: 'acct-1',
    bootstrapBalanceMicroUsd: 1_000_000,
  })

  const reservation = await actor.reserve({
    reservationId: 'res-1',
    requestId: 'req-1',
    estimatedMicroUsd: 1_000,
    provider: 'openai',
    model: 'gpt-4.1-mini',
    now: '2026-05-20T00:00:00Z',
  })
  assert.equal(reservation.reservationId, 'res-1')

  await actor.settle({
    reservationId: 'res-1',
    actualMicroUsd: 700,
    idempotencyKey: 'settle:req-1',
    now: '2026-05-20T00:00:01Z',
  })

  const snap = await actor.snapshot()
  assert.equal(snap.balanceMicroUsd, 1_000_000 - 700)
  assert.equal(snap.reservedMicroUsd, 0)
})

test('DurableObjectAccountActor throws a typed GatewayError when the DO denies insufficient balance', async () => {
  const durable = new AccountDurableObject(makeState(), {})
  const actor = new DurableObjectAccountActor({
    stub: { fetch: (input, init) => durable.fetch(input instanceof Request ? input : new Request(input, init)) },
    accountId: 'acct-2',
    bootstrapBalanceMicroUsd: 100,
  })

  await assert.rejects(
    actor.reserve({
      reservationId: 'res-too-big',
      requestId: 'req-1',
      estimatedMicroUsd: 5_000,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      now: '2026-05-20T00:00:00Z',
    }),
    (error: unknown) => {
      assert.ok(error && typeof error === 'object' && 'code' in error)
      const typed = error as { code: string; status: number }
      assert.equal(typed.code, 'insufficient_balance')
      assert.equal(typed.status, 402)
      return true
    }
  )
})

test('DurableObjectAccountActor satisfies the AccountActor contract end-to-end (used by relay tests by analogy)', async () => {
  // Spot check by sharing the AccountBalance shape: the actor wraps a DO that
  // wraps an AccountBalance, so credit + snapshot through the actor must
  // match what AccountBalance would have produced standalone.
  const durable = new AccountDurableObject(makeState(), {})
  const actor = new DurableObjectAccountActor({
    stub: { fetch: (input, init) => durable.fetch(input instanceof Request ? input : new Request(input, init)) },
    accountId: 'acct-3',
    bootstrapBalanceMicroUsd: 0,
  })

  await actor.credit(2_000_000, '2026-05-20T00:00:00Z')
  const snap = await actor.snapshot()

  const reference = new AccountBalance({ accountId: 'acct-3', balanceMicroUsd: 0 })
  reference.credit(2_000_000, '2026-05-20T00:00:00Z')

  assert.deepEqual(snap, reference.snapshot())
})

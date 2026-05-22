/// <reference types="@cloudflare/workers-types" />
/// <reference path="../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

// These run inside a real workerd via @cloudflare/vitest-pool-workers, so the
// AccountDurableObject is exercised with Cloudflare's genuine single-instance
// guarantee, storage durability, and alarm scheduling — the things our
// in-process FakeStorage can only approximate.

declare global {
  namespace Cloudflare {
    interface Env {
      ACCOUNT_DO: DurableObjectNamespace
    }
  }
}

async function reserve(
  stub: DurableObjectStub,
  input: {
    accountId: string
    bootstrapBalanceMicroUsd: number
    reservationId: string
    estimatedMicroUsd: number
    now?: string
  }
) {
  const response = await stub.fetch('https://account-do/reserve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountId: input.accountId,
      bootstrap: { balanceMicroUsd: input.bootstrapBalanceMicroUsd },
      reservationId: input.reservationId,
      requestId: input.reservationId,
      estimatedMicroUsd: input.estimatedMicroUsd,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      now: input.now ?? new Date().toISOString(),
    }),
  })
  return (await response.json()) as { ok: boolean; code?: string }
}

describe('AccountDurableObject on real workerd', () => {
  it('serializes concurrent reserves so balance can never go negative', async () => {
    const id = env.ACCOUNT_DO.idFromName('concurrency-acct')
    const stub = env.ACCOUNT_DO.get(id)

    // Balance fits exactly 5 reservations of 200 (1000 total). Fire 20 in
    // parallel; the single-threaded DO must accept at most 5.
    const attempts = Array.from({ length: 20 }, (_unused, i) =>
      reserve(stub, {
        accountId: 'concurrency-acct',
        bootstrapBalanceMicroUsd: 1_000,
        reservationId: `res-${i}`,
        estimatedMicroUsd: 200,
      })
    )
    const results = await Promise.all(attempts)
    const accepted = results.filter((r) => r.ok)
    const denied = results.filter((r) => !r.ok)

    expect(accepted.length).toBe(5)
    expect(denied.length).toBe(15)
    expect(denied.every((r) => r.code === 'insufficient_balance')).toBe(true)

    // Confirm via the DO's own snapshot that reserved never exceeded balance.
    const snapshot = await runInDurableObject(stub, async (_instance: unknown, state: DurableObjectState) => {
      const stored = await state.storage.get<{ state: { balanceMicroUsd: number; reservedMicroUsd: number } }>(
        'account_state_v1'
      )
      return stored?.state
    })
    expect(snapshot?.reservedMicroUsd).toBe(1_000)
    expect(snapshot?.balanceMicroUsd).toBe(1_000)
  })

  it('persists balance across DO eviction and survives a fresh stub', async () => {
    const id = env.ACCOUNT_DO.idFromName('persist-acct')
    const first = env.ACCOUNT_DO.get(id)
    await reserve(first, {
      accountId: 'persist-acct',
      bootstrapBalanceMicroUsd: 5_000,
      reservationId: 'res-1',
      estimatedMicroUsd: 1_000,
    })
    await first.fetch('https://account-do/settle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: 'persist-acct',
        reservationId: 'res-1',
        actualMicroUsd: 750,
        idempotencyKey: 'settle:res-1',
        now: new Date().toISOString(),
      }),
    })

    // A brand new stub for the same id reaches the same persisted instance.
    const second = env.ACCOUNT_DO.get(id)
    const snapResponse = await second.fetch('https://account-do/snapshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'persist-acct' }),
    })
    const snap = (await snapResponse.json()) as { value: { balanceMicroUsd: number } }
    expect(snap.value.balanceMicroUsd).toBe(5_000 - 750)
  })

  it('auto-refunds a stale reservation when the alarm fires', async () => {
    const id = env.ACCOUNT_DO.idFromName('alarm-acct')
    const stub = env.ACCOUNT_DO.get(id)

    // Reserve with a createdAt far in the past so the alarm sweep treats it as
    // expired immediately.
    await reserve(stub, {
      accountId: 'alarm-acct',
      bootstrapBalanceMicroUsd: 5_000,
      reservationId: 'res-stale',
      estimatedMicroUsd: 1_000,
      now: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    })

    // The reservation's createdAt is an hour old, so ensureExpiryAlarm
    // scheduled the sweep in the past — workerd may have auto-fired it
    // already. runDurableObjectAlarm forces any still-pending alarm; either
    // way, once it resolves the sweep has definitely run, so we assert the
    // end state rather than the (timing-dependent) return value.
    await runDurableObjectAlarm(stub)

    const snapResponse = await stub.fetch('https://account-do/snapshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'alarm-acct' }),
    })
    const snap = (await snapResponse.json()) as { value: { reservedMicroUsd: number } }
    expect(snap.value.reservedMicroUsd).toBe(0)
  })
})

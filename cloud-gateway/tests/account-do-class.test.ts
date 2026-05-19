import assert from 'node:assert/strict'
import test from 'node:test'
import { AccountDurableObject } from '../src/billing/account-do-class.js'
import type { DurableObjectState, DurableObjectStorage } from '../src/billing/cloudflare-types.js'

class FakeStorage implements DurableObjectStorage {
  private readonly map = new Map<string, unknown>()

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, JSON.parse(JSON.stringify(value)))
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key)
  }
}

function makeState(storage: DurableObjectStorage = new FakeStorage()): DurableObjectState {
  return {
    id: { toString: () => 'fake-do-id' },
    storage,
    blockConcurrencyWhile: async (cb) => cb(),
  }
}

async function rpc(
  durable: AccountDurableObject,
  method: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; value?: unknown; code?: string; status?: number }> {
  const response = await durable.fetch(
    new Request(`https://account-do/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  )
  return (await response.json()) as { ok: boolean; value?: unknown; code?: string; status?: number }
}

test('AccountDurableObject reserves, settles, and reflects balance via snapshot', async () => {
  const storage = new FakeStorage()
  const durable = new AccountDurableObject(makeState(storage), {})

  const reserve = await rpc(durable, 'reserve', {
    accountId: 'acct-1',
    bootstrap: { balanceMicroUsd: 10_000 },
    reservationId: 'res-1',
    requestId: 'req-1',
    estimatedMicroUsd: 500,
    provider: 'openai',
    model: 'gpt-4.1-mini',
    now: '2026-05-20T00:00:00Z',
  })
  assert.equal(reserve.ok, true)

  const settle = await rpc(durable, 'settle', {
    accountId: 'acct-1',
    reservationId: 'res-1',
    actualMicroUsd: 320,
    idempotencyKey: 'settle:req-1',
    now: '2026-05-20T00:00:01Z',
  })
  assert.equal(settle.ok, true)

  const snap = await rpc(durable, 'snapshot', { accountId: 'acct-1' })
  assert.deepEqual(snap.value, {
    accountId: 'acct-1',
    status: 'active',
    balanceMicroUsd: 9_680,
    reservedMicroUsd: 0,
    availableMicroUsd: 9_680,
  })
})

test('AccountDurableObject rehydrates balance from storage across restarts', async () => {
  const storage = new FakeStorage()

  const first = new AccountDurableObject(makeState(storage), {})
  await rpc(first, 'reserve', {
    accountId: 'acct-2',
    bootstrap: { balanceMicroUsd: 2_000_000 },
    reservationId: 'res-1',
    requestId: 'req-1',
    estimatedMicroUsd: 100_000,
    provider: 'openai',
    model: 'gpt-4.1-mini',
    now: '2026-05-20T00:00:00Z',
  })
  await rpc(first, 'settle', {
    accountId: 'acct-2',
    reservationId: 'res-1',
    actualMicroUsd: 75_000,
    idempotencyKey: 'settle:req-1',
    now: '2026-05-20T00:00:01Z',
  })

  // Simulate the DO hibernating + waking up on a new request: same storage,
  // fresh class instance.
  const second = new AccountDurableObject(makeState(storage), {})
  const snap = await rpc(second, 'snapshot', { accountId: 'acct-2' })
  const value = snap.value as { balanceMicroUsd: number; reservedMicroUsd: number }
  assert.equal(value.balanceMicroUsd, 2_000_000 - 75_000)
  assert.equal(value.reservedMicroUsd, 0)
})

test('AccountDurableObject returns ok=false envelope on insufficient balance instead of throwing', async () => {
  const durable = new AccountDurableObject(makeState(), {})
  const reserve = await rpc(durable, 'reserve', {
    accountId: 'acct-3',
    bootstrap: { balanceMicroUsd: 50 },
    reservationId: 'res-too-big',
    requestId: 'req-1',
    estimatedMicroUsd: 9_000,
    provider: 'openai',
    model: 'gpt-4.1-mini',
    now: '2026-05-20T00:00:00Z',
  })
  assert.equal(reserve.ok, false)
  assert.equal(reserve.code, 'insufficient_balance')
  assert.equal(reserve.status, 402)
})

test('AccountDurableObject serializes reservations across concurrent reserve calls', async () => {
  const storage = new FakeStorage()
  const durable = new AccountDurableObject(makeState(storage), {})

  // Within one DO instance the storage put is awaited inside ensureHydrated +
  // each handler. Two reserves of 600 against 1000 should NOT both succeed.
  const both = await Promise.all([
    rpc(durable, 'reserve', {
      accountId: 'acct-4',
      bootstrap: { balanceMicroUsd: 1_000 },
      reservationId: 'res-A',
      requestId: 'req-A',
      estimatedMicroUsd: 600,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      now: '2026-05-20T00:00:00Z',
    }),
    rpc(durable, 'reserve', {
      accountId: 'acct-4',
      bootstrap: { balanceMicroUsd: 1_000 },
      reservationId: 'res-B',
      requestId: 'req-B',
      estimatedMicroUsd: 600,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      now: '2026-05-20T00:00:00Z',
    }),
  ])
  const succeeded = both.filter((r) => r.ok)
  const denied = both.filter((r) => !r.ok && r.code === 'insufficient_balance')
  assert.equal(succeeded.length, 1, 'exactly one reserve must succeed')
  assert.equal(denied.length, 1, 'the other must be denied with insufficient_balance')
})

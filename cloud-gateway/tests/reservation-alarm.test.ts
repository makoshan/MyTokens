import assert from 'node:assert/strict'
import test from 'node:test'
import { AccountBalance, RESERVATION_MAX_AGE_MS } from '../src/billing/account-do.js'
import { AccountDurableObject } from '../src/billing/account-do-class.js'
import type { DurableObjectState, DurableObjectStorage } from '../src/billing/cloudflare-types.js'

class FakeStorage implements DurableObjectStorage {
  private readonly map = new Map<string, unknown>()
  alarmAt: number | null = null

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, JSON.parse(JSON.stringify(value)))
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key)
  }
  async setAlarm(scheduledTimeMs: number | Date): Promise<void> {
    this.alarmAt = typeof scheduledTimeMs === 'number' ? scheduledTimeMs : scheduledTimeMs.getTime()
  }
  async getAlarm(): Promise<number | null> {
    return this.alarmAt
  }
  async deleteAlarm(): Promise<void> {
    this.alarmAt = null
  }
}

function makeState(storage: FakeStorage = new FakeStorage()): { state: DurableObjectState; storage: FakeStorage } {
  return {
    state: {
      id: { toString: () => 'fake-do' },
      storage,
      blockConcurrencyWhile: async (cb) => cb(),
    },
    storage,
  }
}

test('expireStaleReservations refunds only reservations older than maxAge and leaves fresh ones alone', () => {
  const balance = new AccountBalance({ accountId: 'acct-1', balanceMicroUsd: 10_000 })
  // First reservation is "old"
  balance.reserve({
    reservationId: 'res-old',
    requestId: 'req-old',
    estimatedMicroUsd: 1_000,
    provider: 'openai',
    model: 'gpt-4.1-mini',
    now: '2026-05-20T12:00:00.000Z',
  })
  // Second is "fresh"
  balance.reserve({
    reservationId: 'res-fresh',
    requestId: 'req-fresh',
    estimatedMicroUsd: 2_000,
    provider: 'openai',
    model: 'gpt-4.1-mini',
    now: '2026-05-20T12:04:30.000Z',
  })

  // Sweep at t = old + 5min01s.
  const refunded = balance.expireStaleReservations('2026-05-20T12:05:01.000Z', RESERVATION_MAX_AGE_MS)
  assert.equal(refunded.length, 1)
  assert.equal(refunded[0].reservationId, 'res-old')
  // Only the old reservation came back into available balance.
  assert.equal(balance.snapshot().reservedMicroUsd, 2_000)
  assert.equal(balance.hasOpenReservations(), true)
})

test('expireStaleReservations is idempotent — replaying the sweep refunds nothing extra', () => {
  const balance = new AccountBalance({ accountId: 'acct-2', balanceMicroUsd: 10_000 })
  balance.reserve({
    reservationId: 'res-old',
    requestId: 'req-old',
    estimatedMicroUsd: 1_500,
    provider: 'openai',
    model: 'gpt-4.1-mini',
    now: '2026-05-20T12:00:00.000Z',
  })

  const first = balance.expireStaleReservations('2026-05-20T12:06:00.000Z', RESERVATION_MAX_AGE_MS)
  const second = balance.expireStaleReservations('2026-05-20T12:07:00.000Z', RESERVATION_MAX_AGE_MS)
  assert.equal(first.length, 1)
  assert.equal(second.length, 0)
  assert.equal(balance.snapshot().reservedMicroUsd, 0)
  assert.equal(balance.hasOpenReservations(), false)
})

test('settled reservations are never re-expired by the sweep', () => {
  const balance = new AccountBalance({ accountId: 'acct-3', balanceMicroUsd: 10_000 })
  balance.reserve({
    reservationId: 'res-settled',
    requestId: 'req-settled',
    estimatedMicroUsd: 500,
    provider: 'openai',
    model: 'gpt-4.1-mini',
    now: '2026-05-20T12:00:00.000Z',
  })
  balance.settle({
    reservationId: 'res-settled',
    actualMicroUsd: 400,
    idempotencyKey: 'settle:req-settled',
    now: '2026-05-20T12:00:01.000Z',
  })
  const refunded = balance.expireStaleReservations('2026-05-20T12:10:00.000Z', RESERVATION_MAX_AGE_MS)
  assert.equal(refunded.length, 0)
  // Balance unchanged: 10_000 - 400 (settled cost) = 9_600.
  assert.equal(balance.snapshot().balanceMicroUsd, 9_600)
})

test('AccountDurableObject schedules an alarm on reserve and clears it once everything is settled', async () => {
  const { state, storage } = makeState()
  const durable = new AccountDurableObject(state, {})

  const reserveAt = '2026-05-20T12:00:00.000Z'
  const reserve = await durable.fetch(
    new Request('https://account-do/reserve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: 'acct-alarm-1',
        bootstrap: { balanceMicroUsd: 5_000 },
        reservationId: 'res-1',
        requestId: 'req-1',
        estimatedMicroUsd: 1_000,
        provider: 'openai',
        model: 'gpt-4.1-mini',
        now: reserveAt,
      }),
    })
  )
  assert.equal(reserve.status, 200)
  assert.equal(storage.alarmAt, Date.parse(reserveAt) + RESERVATION_MAX_AGE_MS)

  // Settle clears the open reservation; the next alarm() must delete itself.
  await durable.fetch(
    new Request('https://account-do/settle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: 'acct-alarm-1',
        reservationId: 'res-1',
        actualMicroUsd: 500,
        idempotencyKey: 'settle:req-1',
        now: '2026-05-20T12:00:01.000Z',
      }),
    })
  )
  // Settle does not retract the alarm (that would require knowing nothing
  // else is open). The alarm fires once, finds nothing to sweep, and clears.
  await durable.alarm()
  assert.equal(storage.alarmAt, null)
})

test('AccountDurableObject.alarm() refunds the abandoned reservation and reschedules when other reservations remain', async () => {
  const { state, storage } = makeState()
  const durable = new AccountDurableObject(state, {})

  // alarm() reads its sweep timestamp from the real system clock, so we have
  // to pick reservation createdAt values relative to Date.now() instead of a
  // hard-coded ISO string.
  const oldAt = new Date(Date.now() - 10 * 60 * 1000).toISOString() // 10 min ago
  await durable.fetch(
    new Request('https://account-do/reserve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: 'acct-alarm-2',
        bootstrap: { balanceMicroUsd: 5_000 },
        reservationId: 'res-old',
        requestId: 'req-old',
        estimatedMicroUsd: 1_000,
        provider: 'openai',
        model: 'gpt-4.1-mini',
        now: oldAt,
      }),
    })
  )
  await durable.fetch(
    new Request('https://account-do/reserve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: 'acct-alarm-2',
        bootstrap: { balanceMicroUsd: 5_000 },
        reservationId: 'res-fresh',
        requestId: 'req-fresh',
        // Fresh reservation made right before the sweep — must survive.
        now: new Date(Date.now() - 1_000).toISOString(),
        estimatedMicroUsd: 1_500,
        provider: 'openai',
        model: 'gpt-4.1-mini',
      }),
    })
  )

  await durable.alarm()

  const snap = await durable.fetch(
    new Request('https://account-do/snapshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'acct-alarm-2' }),
    })
  )
  const snapPayload = (await snap.json()) as { value: { reservedMicroUsd: number } }
  assert.equal(snapPayload.value.reservedMicroUsd, 1_500, 'old reservation refunded, fresh one retained')
  assert.ok(storage.alarmAt !== null, 'alarm must be rescheduled while at least one reservation is still open')
})

import { GatewayError } from '../errors.js'

export type ReservationStatus = 'open' | 'settled' | 'refunded' | 'expired'

export interface Reservation {
  reservationId: string
  requestId: string
  accountId: string
  estimatedMicroUsd: number
  status: ReservationStatus
  provider: string
  model: string
  createdAt: string
}

export interface LedgerEntry {
  id: string
  accountId: string
  type: 'credit' | 'debit' | 'reserve' | 'settle' | 'refund'
  amountMicroUsd: number
  balanceAfterMicroUsd: number
  reservationId?: string
  requestId?: string
  createdAt: string
}

export class AccountBalance {
  private balanceMicroUsd: number
  private reservedMicroUsd = 0
  private status: 'active' | 'paused' = 'active'
  private readonly accountId: string
  private readonly reservations = new Map<string, Reservation>()
  private readonly idempotencyResults = new Map<string, LedgerEntry>()
  readonly ledger: LedgerEntry[] = []

  constructor(input: { accountId: string; balanceMicroUsd?: number }) {
    this.accountId = input.accountId
    this.balanceMicroUsd = input.balanceMicroUsd ?? 0
  }

  snapshot() {
    return {
      accountId: this.accountId,
      status: this.status,
      balanceMicroUsd: this.balanceMicroUsd,
      reservedMicroUsd: this.reservedMicroUsd,
      availableMicroUsd: this.balanceMicroUsd - this.reservedMicroUsd,
    }
  }

  credit(amountMicroUsd: number, now = new Date().toISOString()): LedgerEntry {
    this.balanceMicroUsd += amountMicroUsd
    return this.pushLedger({
      type: 'credit',
      amountMicroUsd,
      createdAt: now,
    })
  }

  pause(): void {
    this.status = 'paused'
  }

  reserve(input: {
    reservationId: string
    requestId: string
    estimatedMicroUsd: number
    provider: string
    model: string
    now?: string
  }): Reservation {
    if (this.status !== 'active') throw new GatewayError('account_paused', 403)
    if (!Number.isInteger(input.estimatedMicroUsd) || input.estimatedMicroUsd < 0) {
      throw new GatewayError('invalid_reservation_amount', 400)
    }
    if (this.balanceMicroUsd - this.reservedMicroUsd < input.estimatedMicroUsd) {
      throw new GatewayError('insufficient_balance', 402)
    }
    const existing = this.reservations.get(input.reservationId)
    if (existing) return existing

    const reservation: Reservation = {
      reservationId: input.reservationId,
      requestId: input.requestId,
      accountId: this.accountId,
      estimatedMicroUsd: input.estimatedMicroUsd,
      status: 'open',
      provider: input.provider,
      model: input.model,
      createdAt: input.now ?? new Date().toISOString(),
    }
    this.reservations.set(input.reservationId, reservation)
    this.reservedMicroUsd += input.estimatedMicroUsd
    this.pushLedger({
      type: 'reserve',
      amountMicroUsd: 0,
      reservationId: input.reservationId,
      requestId: input.requestId,
      createdAt: reservation.createdAt,
    })
    return reservation
  }

  settle(input: {
    reservationId: string
    actualMicroUsd: number
    idempotencyKey: string
    now?: string
  }): LedgerEntry {
    const replay = this.idempotencyResults.get(input.idempotencyKey)
    if (replay) return replay

    const reservation = this.reservations.get(input.reservationId)
    if (!reservation || reservation.status !== 'open') throw new GatewayError('reservation_not_open', 409)
    if (this.balanceMicroUsd < input.actualMicroUsd) throw new GatewayError('insufficient_balance', 402)

    this.reservedMicroUsd -= reservation.estimatedMicroUsd
    this.balanceMicroUsd -= input.actualMicroUsd
    reservation.status = 'settled'

    const entry = this.pushLedger({
      type: 'settle',
      amountMicroUsd: -input.actualMicroUsd,
      reservationId: input.reservationId,
      requestId: reservation.requestId,
      createdAt: input.now ?? new Date().toISOString(),
    })
    this.idempotencyResults.set(input.idempotencyKey, entry)
    return entry
  }

  refund(input: { reservationId: string; idempotencyKey: string; now?: string }): LedgerEntry {
    const replay = this.idempotencyResults.get(input.idempotencyKey)
    if (replay) return replay

    const reservation = this.reservations.get(input.reservationId)
    if (!reservation || reservation.status !== 'open') throw new GatewayError('reservation_not_open', 409)
    this.reservedMicroUsd -= reservation.estimatedMicroUsd
    reservation.status = 'refunded'

    const entry = this.pushLedger({
      type: 'refund',
      amountMicroUsd: 0,
      reservationId: input.reservationId,
      requestId: reservation.requestId,
      createdAt: input.now ?? new Date().toISOString(),
    })
    this.idempotencyResults.set(input.idempotencyKey, entry)
    return entry
  }

  private pushLedger(input: Omit<LedgerEntry, 'id' | 'accountId' | 'balanceAfterMicroUsd'>): LedgerEntry {
    const entry: LedgerEntry = {
      id: `ledger_${this.ledger.length + 1}`,
      accountId: this.accountId,
      balanceAfterMicroUsd: this.balanceMicroUsd,
      ...input,
    }
    this.ledger.push(entry)
    return entry
  }
}

export class AccountDurableObject extends AccountBalance {}

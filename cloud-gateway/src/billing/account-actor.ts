import { AccountBalance, type LedgerEntry, type Reservation } from './account-do.js'

export interface AccountSnapshot {
  accountId: string
  status: 'active' | 'paused'
  balanceMicroUsd: number
  reservedMicroUsd: number
  availableMicroUsd: number
}

export interface ReserveInput {
  reservationId: string
  requestId: string
  estimatedMicroUsd: number
  provider: string
  model: string
  now?: string
}

export interface SettleInput {
  reservationId: string
  actualMicroUsd: number
  idempotencyKey: string
  now?: string
}

export interface RefundInput {
  reservationId: string
  idempotencyKey: string
  now?: string
}

/**
 * AccountActor is the single async-friendly façade over a buyer's balance and
 * reservations. The in-process implementation wraps {@link AccountBalance}
 * directly; a future Durable Object implementation will forward each method
 * over RPC so all reads and writes for one account are serialized by the
 * single-instance guarantee of Cloudflare DOs.
 *
 * Relay code never depends on the concrete type, only on this interface, so
 * we can swap implementations behind handleRelayRoute without touching the
 * hot path.
 */
export interface AccountActor {
  reserve(input: ReserveInput): Promise<Reservation>
  settle(input: SettleInput): Promise<LedgerEntry>
  refund(input: RefundInput): Promise<LedgerEntry>
  credit(amountMicroUsd: number, now?: string): Promise<LedgerEntry>
  snapshot(): Promise<AccountSnapshot>
  pause(): Promise<void>
}

export class InProcessAccountActor implements AccountActor {
  constructor(
    private readonly balance: AccountBalance,
    options?: { rpmLimit?: number | null }
  ) {
    if (options?.rpmLimit !== undefined) {
      balance.setRpmLimit(options.rpmLimit ?? null)
    }
  }

  async reserve(input: ReserveInput): Promise<Reservation> {
    return this.balance.reserve(input)
  }

  async settle(input: SettleInput): Promise<LedgerEntry> {
    return this.balance.settle(input)
  }

  async refund(input: RefundInput): Promise<LedgerEntry> {
    return this.balance.refund(input)
  }

  async credit(amountMicroUsd: number, now?: string): Promise<LedgerEntry> {
    return this.balance.credit(amountMicroUsd, now)
  }

  async snapshot(): Promise<AccountSnapshot> {
    return this.balance.snapshot()
  }

  async pause(): Promise<void> {
    this.balance.pause()
  }

  /**
   * Direct access to the wrapped sync balance. Production worker code uses
   * this only after the relay has fully settled (await snapshot/await settle)
   * so it can persist the resulting balance to D1 — never to bypass the
   * actor's serialization guarantee.
   */
  get underlying(): AccountBalance {
    return this.balance
  }
}

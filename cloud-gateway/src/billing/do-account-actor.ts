import { GatewayError } from '../errors.js'
import type { AccountActor, AccountSnapshot, RefundInput, ReserveInput, SettleInput } from './account-actor.js'
import type { LedgerEntry, Reservation } from './account-do.js'
import type { DurableRpcResult } from './account-do-class.js'

/**
 * Subset of DurableObjectStub the actor needs. Matches the runtime contract
 * provided by env.ACCOUNT_DO.get(id) so we can swap in a mock for tests.
 */
export interface DurableObjectAccountStub {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>
}

export interface DurableObjectAccountActorInput {
  stub: DurableObjectAccountStub
  accountId: string
  bootstrapBalanceMicroUsd: number
}

/**
 * Forwards every reserve/settle/refund/credit/snapshot to the single
 * AccountDurableObject instance for this account so Cloudflare's
 * per-DO single-threading semantics serialize the writes. The bootstrap
 * balance is sent on every call (cheap) so the first activation of a
 * DO that hasn't seen the account yet can seed itself from D1 without
 * an extra round-trip.
 */
export class DurableObjectAccountActor implements AccountActor {
  private readonly stub: DurableObjectAccountStub
  private readonly accountId: string
  private readonly bootstrapBalanceMicroUsd: number

  constructor(input: DurableObjectAccountActorInput) {
    this.stub = input.stub
    this.accountId = input.accountId
    this.bootstrapBalanceMicroUsd = input.bootstrapBalanceMicroUsd
  }

  async reserve(input: ReserveInput): Promise<Reservation> {
    return this.call<Reservation>('reserve', input)
  }

  async settle(input: SettleInput): Promise<LedgerEntry> {
    return this.call<LedgerEntry>('settle', input)
  }

  async refund(input: RefundInput): Promise<LedgerEntry> {
    return this.call<LedgerEntry>('refund', input)
  }

  async credit(amountMicroUsd: number, now?: string): Promise<LedgerEntry> {
    return this.call<LedgerEntry>('credit', { amountMicroUsd, now: now ?? new Date().toISOString() })
  }

  async snapshot(): Promise<AccountSnapshot> {
    return this.call<AccountSnapshot>('snapshot', {})
  }

  async pause(): Promise<void> {
    await this.call<{ ok: true }>('pause', {})
  }

  private async call<T>(method: string, payload: object): Promise<T> {
    const body = {
      accountId: this.accountId,
      bootstrap: { balanceMicroUsd: this.bootstrapBalanceMicroUsd },
      ...payload,
    }
    const response = await this.stub.fetch(`https://account-do/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const result = (await response.json()) as DurableRpcResult<T>
    if (!result.ok) {
      throw new GatewayError(result.code, result.status)
    }
    return result.value
  }
}

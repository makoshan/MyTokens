import { GatewayError } from '../errors.js'
import { AccountBalance, type AccountBalanceState, type LedgerEntry, type Reservation } from './account-do.js'
import type { DurableObjectState } from './cloudflare-types.js'

/**
 * Persisted shape for the AccountDurableObject. Kept versioned so future
 * migrations can detect old storage payloads and upgrade them in place.
 */
interface PersistedDOState {
  version: 1
  state: AccountBalanceState
}

/**
 * RPC envelope between the Worker (via DurableObjectStub.fetch) and the DO.
 * Errors are returned as `{ ok: false, code, status }` rather than thrown so
 * the stub side can rebuild a typed GatewayError without parsing strings.
 */
type DurableRpcSuccess<T> = { ok: true; value: T }
type DurableRpcFailure = { ok: false; code: string; status: number }
export type DurableRpcResult<T> = DurableRpcSuccess<T> | DurableRpcFailure

export interface ReserveDOInput {
  reservationId: string
  requestId: string
  estimatedMicroUsd: number
  provider: string
  model: string
  now: string
  bootstrap?: { balanceMicroUsd: number }
}

export interface SettleDOInput {
  reservationId: string
  actualMicroUsd: number
  idempotencyKey: string
  now: string
}

export interface RefundDOInput {
  reservationId: string
  idempotencyKey: string
  now: string
}

export interface CreditDOInput {
  amountMicroUsd: number
  now: string
  bootstrap?: { balanceMicroUsd: number }
}

export interface SnapshotDOInput {
  bootstrap?: { balanceMicroUsd: number }
}

const STORAGE_KEY = 'account_state_v1'

/**
 * AccountDurableObject — the single source of truth for one buyer account's
 * balance and reservations on the hot path. Cloudflare guarantees there is
 * exactly one instance per `idFromName(accountId)` globally and that its
 * fetch handler is single-threaded, so concurrent reserve calls cannot
 * over-spend the way the previous per-request AccountBalance could.
 *
 * The class deliberately does NOT `import { DurableObject } from "cloudflare:workers"`.
 * Node's tsc + node:test runner both fail to resolve that module, and DOs
 * still work in workerd via the legacy fetch handler interface plus the
 * `DurableObjectState` constructor injection. The class is exported from
 * the Worker entrypoint so wrangler can bind it; tests never instantiate
 * it.
 */
export class AccountDurableObject {
  private balance: AccountBalance | null = null
  private hydrationLock: Promise<void> | null = null

  constructor(
    private readonly state: DurableObjectState,
    // env is provided by wrangler but unused for now; future versions will
    // read D1 here for first-time hydration from historical ledger rows.
    _env: unknown
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const method = url.pathname.replace(/^\/+/, '')
    let body: Record<string, unknown> = {}
    if (request.method === 'POST') {
      try {
        body = (await request.json()) as Record<string, unknown>
      } catch {
        return failure('invalid_rpc_body', 400)
      }
    }
    const accountId = typeof body.accountId === 'string' ? body.accountId : url.searchParams.get('accountId')
    if (!accountId) return failure('account_id_required', 400)

    try {
      const balance = await this.ensureHydrated(accountId, body.bootstrap as { balanceMicroUsd: number } | undefined)
      switch (method) {
        case 'reserve': {
          const input = body as unknown as ReserveDOInput
          const result = balance.reserve(input)
          await this.persist()
          return success(result)
        }
        case 'settle': {
          const input = body as unknown as SettleDOInput
          const result = balance.settle(input)
          await this.persist()
          return success(result)
        }
        case 'refund': {
          const input = body as unknown as RefundDOInput
          const result = balance.refund(input)
          await this.persist()
          return success(result)
        }
        case 'credit': {
          const input = body as unknown as CreditDOInput
          const result = balance.credit(input.amountMicroUsd, input.now)
          await this.persist()
          return success(result)
        }
        case 'snapshot':
          return success(balance.snapshot())
        case 'pause':
          balance.pause()
          await this.persist()
          return success({ ok: true })
        default:
          return failure('unknown_rpc_method', 404)
      }
    } catch (error) {
      if (error instanceof GatewayError) {
        return failure(error.code, error.status)
      }
      throw error
    }
  }

  private async ensureHydrated(accountId: string, bootstrap: { balanceMicroUsd: number } | undefined): Promise<AccountBalance> {
    if (this.balance) return this.balance
    if (this.hydrationLock) await this.hydrationLock
    if (this.balance) return this.balance
    this.hydrationLock = this.state.blockConcurrencyWhile(async () => {
      if (this.balance) return
      const stored = await this.state.storage.get<PersistedDOState>(STORAGE_KEY)
      if (stored && stored.version === 1) {
        this.balance = AccountBalance.fromState(stored.state)
        return
      }
      this.balance = new AccountBalance({
        accountId,
        balanceMicroUsd: bootstrap?.balanceMicroUsd ?? 0,
      })
      await this.persistUnlocked()
    })
    await this.hydrationLock
    this.hydrationLock = null
    return this.balance as unknown as AccountBalance
  }

  private async persist(): Promise<void> {
    if (!this.balance) return
    await this.persistUnlocked()
  }

  private async persistUnlocked(): Promise<void> {
    if (!this.balance) return
    const payload: PersistedDOState = { version: 1, state: this.balance.toState() }
    await this.state.storage.put(STORAGE_KEY, payload)
  }
}

function success<T>(value: T): Response {
  const body: DurableRpcSuccess<T> = { ok: true, value }
  return Response.json(body, { status: 200 })
}

function failure(code: string, status: number): Response {
  const body: DurableRpcFailure = { ok: false, code, status }
  return Response.json(body, { status: 200 })
}

export type { LedgerEntry, Reservation }

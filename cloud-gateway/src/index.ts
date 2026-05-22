import { isAdminIpAllowed } from './admin-ip.js'
import { recordAuditAdminAction } from './audit.js'
import { createApiKey, registerApiKey, verifyApiKey } from './auth/api-keys.js'
import type { AccountActor } from './billing/account-actor.js'
import { InProcessAccountActor } from './billing/account-actor.js'
import { AccountBalance } from './billing/account-do.js'
import { AccountDurableObject } from './billing/account-do-class.js'
import { DurableObjectAccountActor } from './billing/do-account-actor.js'
import { D1GatewayStore, type D1Database, type GatewayStore } from './db/store.js'
import { GatewayError, toErrorResponse } from './errors.js'
import { anthropicAdapter } from './providers/anthropic.js'
import type { ProviderAdapter } from './providers/adapter.js'
import { openAIAdapter, openAIChatCompletionsAdapter } from './providers/openai.js'
import { createDashboardSession, createInviteToken, hashDashboardToken } from './routes/dashboard.js'
import { verifyOperatorChallenge } from './routes/operator-auth.js'
import { relayCompletion, relayCompletionStream } from './routes/relay.js'
import { verifyAndCreditBurn, type TopupConfig } from './routes/topup.js'
import { relayerTransfer, relayerBurnWithSig, relayerTransferWithSig, relayerMint, relayerAddress, relayerWithdrawToken } from './routes/relayer.js'
import { resolveRoutingRule } from './routing/router.js'
import type {
  CreditRequestRecord,
  CreditRequestStatus,
  PriceBookRow,
  ProviderTokenSummary,
  RoutingRule,
} from './types.js'
import { decryptProviderToken, encryptProviderToken } from './vault/provider-tokens.js'

export { AccountDurableObject }

export interface GatewayDurableObjectNamespace {
  idFromName(name: string): { toString(): string } & object
  get(id: object): { fetch(input: Request | string, init?: RequestInit): Promise<Response> }
}

export interface GatewayEnv {
  DB?: D1Database
  SERVER_PEPPER?: string
  ADMIN_TOKEN?: string
  ADMIN_IP_ALLOWLIST?: string
  PUBLIC_GATEWAY_URL?: string
  MASTER_KEY_V1?: string
  ACCOUNT_DO?: GatewayDurableObjectNamespace
  ACCOUNT_RPM_LIMIT?: string
  ASSETS?: { fetch(request: Request): Promise<Response> }
  TEMPO_RPC_URL?: string
  TEMPO_CHAIN_ID?: string
  MYC_TOKEN_ADDRESS?: string
  MYC_MICRO_USD_PER_TOKEN?: string
  RELAYER_PRIVATE_KEY?: string
  // Test stablecoin (USDT) used to buy MYC. Validation only — on mainnet this is
  // real USDC. MYC minted per 1 whole stablecoin (default 1:1).
  STABLECOIN_TOKEN_ADDRESS?: string
  STABLECOIN_MYC_RATE?: string
  // Per-call faucet grant (raw 6-decimal). Faucet is testnet-only (Sepolia).
  STABLECOIN_FAUCET_AMOUNT?: string
}

export interface GatewayAppOptions {
  store?: GatewayStore
  pepper?: string
  adminToken?: string
  adminIpAllowlist?: string[] | string
  accountRpmLimit?: number | null
  baseUrl?: string
  now?: () => string
  masterKeys?: Record<string, Uint8Array>
  fetchImpl?: typeof fetch
  // Injection seam for the on-chain relayer (red-packet transfer + gasless
  // burnWithSig). Defaults to the real viem-backed functions; tests override
  // these so claim/redeem can be exercised without hitting a live RPC.
  relayer?: {
    transfer?: typeof relayerTransfer
    burnWithSig?: typeof relayerBurnWithSig
    transferWithSig?: typeof relayerTransferWithSig
    mint?: typeof relayerMint
    address?: typeof relayerAddress
    withdrawToken?: typeof relayerWithdrawToken
  }
}

export interface GatewayExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

function fallbackExecutionContext(): GatewayExecutionContext {
  return {
    waitUntil() {
      // Tests and local invocations without a Workers runtime ignore this; the
      // caller awaits the relevant promises directly.
    },
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

function parseBooleanQueryParam(value: string | null): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function buildAcceptRedirectLocation(searchParams: URLSearchParams): string {
  const redirectParams = new URLSearchParams()
  const redpacket = searchParams.get('redpacket')
  const tab = searchParams.get('tab')
  if (redpacket) {
    // Red-packet invite: its own claim overlay (envelope → burn MYC) takes over.
    redirectParams.set('redpacket', redpacket)
  } else {
    // Manual-credit invite: a fresh /accept is a first-time join, so signal the
    // welcome/claim overlay (create passkey wallet → reveal granted models + quota).
    redirectParams.set('welcome', '1')
  }
  if (tab) redirectParams.set('tab', tab)
  return redirectParams.size > 0 ? `/?${redirectParams.toString()}` : '/'
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=')
    if (rawKey === name) return decodeURIComponent(rawValue.join('='))
  }
  return null
}

function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization')?.trim() ?? '')
  return match?.[1] ?? null
}

function getStore(options: GatewayAppOptions, env?: GatewayEnv): GatewayStore {
  if (options.store) return options.store
  if (env?.DB) return new D1GatewayStore(env.DB, env.PUBLIC_GATEWAY_URL ?? options.baseUrl ?? 'https://api.mykey.example')
  throw new GatewayError('gateway_store_not_configured', 500)
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function getMasterKeys(options: GatewayAppOptions, env?: GatewayEnv): Record<string, Uint8Array> {
  if (options.masterKeys) return options.masterKeys
  if (env?.MASTER_KEY_V1) return { v1: base64ToBytes(env.MASTER_KEY_V1) }
  throw new GatewayError('master_key_not_configured', 500)
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function ensureInviteDashboardApiKey(
  store: GatewayStore,
  accountId: string,
  pepper: string | undefined,
  now: string
): Promise<void> {
  if (!pepper) return
  const snapshot = await store.getDashboardSnapshot(accountId)
  const hasActiveKey = snapshot.apiKeys.some((apiKey) => apiKey.status === 'active')
  if (hasActiveKey) return

  const created = createApiKey({ environment: 'live' })
  const apiKey = registerApiKey({
    id: `key_${crypto.randomUUID()}`,
    accountId,
    rawKey: created.rawKey,
    pepper,
    now,
    name: '邀请链接自动创建',
  })

  await store.createApiKeyRecord(apiKey)
}

function getTopupConfig(env?: GatewayEnv): TopupConfig {
  const tokenAddress = env?.MYC_TOKEN_ADDRESS
  if (!tokenAddress) throw new GatewayError('topup_not_configured', 500)
  return {
    rpcUrl: env?.TEMPO_RPC_URL ?? 'https://rpc.tempo.xyz',
    chainId: env?.TEMPO_CHAIN_ID ? Number(env.TEMPO_CHAIN_ID) : 4217,
    tokenAddress,
    // 1 MYC = $1 by default (1,000,000 µUSD per whole 6-decimal MYC).
    microUsdPerToken: env?.MYC_MICRO_USD_PER_TOKEN ? Number(env.MYC_MICRO_USD_PER_TOKEN) : 1_000_000,
  }
}

interface StablecoinConfig {
  tokenAddress: string
  /** MYC minted per 1 whole stablecoin. Both are 6-decimal, so this is a raw ratio. */
  mycRate: number
  /** Per-call faucet grant in raw 6-decimal units. */
  faucetAmountRaw: bigint
  /** Faucet (mint) is allowed only on testnet — guards against minting fake USDT in prod. */
  faucetEnabled: boolean
}

function getStablecoinConfig(env?: GatewayEnv): StablecoinConfig {
  const tokenAddress = env?.STABLECOIN_TOKEN_ADDRESS
  if (!tokenAddress) throw new GatewayError('stablecoin_not_configured', 500)
  const chainId = env?.TEMPO_CHAIN_ID ? Number(env.TEMPO_CHAIN_ID) : 11155111
  return {
    tokenAddress,
    mycRate: env?.STABLECOIN_MYC_RATE ? Number(env.STABLECOIN_MYC_RATE) : 1,
    faucetAmountRaw: BigInt(env?.STABLECOIN_FAUCET_AMOUNT ?? '20000000'),
    // Only Sepolia (11155111) — mainnet (e.g. Base 8453) uses real USDC, no faucet.
    faucetEnabled: chainId === 11155111,
  }
}

/** Convert a raw stablecoin amount (6-decimal) to the MYC raw amount it buys. */
function stablecoinToMycRaw(stablecoinRaw: bigint, mycRate: number): bigint {
  // mycRate defaults to 1 (1:1). Support fractional rates via integer math at 1e6 precision.
  const rateScaled = BigInt(Math.round(mycRate * 1_000_000))
  return (stablecoinRaw * rateScaled) / 1_000_000n
}

async function authenticateDashboard(request: Request, store: GatewayStore, now: string): Promise<string> {
  const rawSession =
    parseCookie(request.headers.get('cookie'), 'mykey_dashboard_session') ??
    request.headers.get('x-dashboard-session')
  if (!rawSession) throw new GatewayError('dashboard_auth_required', 401)
  const session = await store.findDashboardSessionByHash(hashDashboardToken(rawSession), now)
  if (!session) throw new GatewayError('dashboard_auth_required', 401)
  // A live session alone isn't enough — a disabled/paused account (e.g. after the
  // operator revokes the invite) must lose dashboard access too, not just relay.
  const account = await store.getAccount(session.accountId)
  if (!account || account.status !== 'active') throw new GatewayError('account_disabled', 403)
  return session.accountId
}

async function authenticateOperator(request: Request, store: GatewayStore, now: string): Promise<string> {
  const raw =
    parseCookie(request.headers.get('cookie'), 'mykey_operator_session') ??
    request.headers.get('x-operator-session')
  if (!raw) throw new GatewayError('operator_auth_required', 401)
  const session = await store.findOperatorSessionByHash(hashDashboardToken(raw), now)
  if (!session) throw new GatewayError('operator_auth_required', 401)
  return session.operatorId
}

async function mintOperatorSession(
  store: GatewayStore,
  operatorId: string,
  now: string
): Promise<{ token: string; expiresAt: string }> {
  const token = `op_sess_${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`
  const expiresAt = new Date(Date.parse(now) + 30 * 24 * 3600 * 1000).toISOString()
  await store.createOperatorSession({
    id: `ops_${crypto.randomUUID()}`,
    operatorId,
    sessionHash: hashDashboardToken(token),
    expiresAt,
  })
  return { token, expiresAt }
}

async function authenticateBuyer(
  request: Request,
  store: GatewayStore,
  pepper: string,
  now: string
): Promise<{ accountId: string; apiKeyId: string }> {
  const result = await verifyApiKey({
    authorizationHeader: request.headers.get('authorization'),
    pepper,
    now,
    findByHash: (hash) => store.findApiKeyByHash(hash),
  })
  if (!result.ok) throw new GatewayError('api_key_auth_required', result.reason === 'revoked' ? 403 : 401)
  return { accountId: result.accountId, apiKeyId: result.apiKey.id }
}

async function requireAdmin(
  request: Request,
  adminToken: string | undefined,
  allowlist: string[] | string | null | undefined
): Promise<void> {
  const ipCheck = isAdminIpAllowed({ request, allowlist: allowlist ?? null })
  if (!ipCheck.allowed) {
    // Fail fast on IP before touching token state so the rejection does not
    // leak whether ADMIN_TOKEN is even configured.
    throw new GatewayError('admin_ip_denied', 403)
  }
  if (!adminToken) throw new GatewayError('admin_not_configured', 500)
  if (bearerToken(request) !== adminToken) throw new GatewayError('admin_auth_required', 401)
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const payload = await request.json().catch(() => null)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new GatewayError('invalid_json_body', 400)
  }
  return payload as Record<string, unknown>
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayError(`invalid_${key}`, 400)
  }
  return value.trim()
}

function optionalStringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function integerField(body: Record<string, unknown>, key: string, fallback?: number): number {
  const value = body[key]
  if (value === undefined && fallback !== undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new GatewayError(`invalid_${key}`, 400)
  return parsed
}

function positiveIntegerField(body: Record<string, unknown>, key: string, fallback?: number): number {
  const value = integerField(body, key, fallback)
  if (value <= 0) throw new GatewayError(`invalid_${key}`, 400)
  return value
}

function booleanField(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key]
  return typeof value === 'boolean' ? value : fallback
}

function stringArrayField(body: Record<string, unknown>, key: string): string[] {
  const value = body[key]
  if (!Array.isArray(value)) throw new GatewayError(`invalid_${key}`, 400)
  const strings = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  if (strings.length === 0 || strings.length !== value.length) throw new GatewayError(`invalid_${key}`, 400)
  return strings.map((item) => item.trim())
}

function optionalStringArrayField(body: Record<string, unknown>, key: string): string[] | undefined {
  if (!(key in body)) return undefined
  return stringArrayField(body, key)
}

function requireActiveAccount(account: Awaited<ReturnType<GatewayStore['getAccount']>>) {
  if (!account) throw new GatewayError('account_not_found', 404)
  if (account.status !== 'active') throw new GatewayError('account_paused', 403)
  return account
}

function ensureAccountModelAllowed(account: Awaited<ReturnType<GatewayStore['getAccount']>>, model: string): void {
  const allowlist = account?.modelAllowlist
  if (allowlist && allowlist.length > 0 && !allowlist.includes(model)) {
    throw new GatewayError('model_not_allowed_for_account', 403)
  }
}

function serializeCreditRequest(record: CreditRequestRecord) {
  return {
    id: record.id,
    account_id: record.accountId,
    requested_micro_usd: record.requestedMicroUsd,
    message: record.message ?? null,
    status: record.status,
    created_at: record.createdAt,
    resolved_at: record.resolvedAt ?? null,
    resolved_by: record.resolvedBy ?? null,
  }
}

function providerTokenSummariesFromChannels(
  channels: Awaited<ReturnType<GatewayStore['listProviderTokenSummaries']>>
): ProviderTokenSummary[] {
  return channels.map((channel) => ({
    id: channel.id,
    provider: channel.provider,
    adapter: channel.adapter,
    baseUrl: channel.baseUrl ?? null,
    status: channel.status === 'active' ? 'active' : 'disabled',
    exhaustedUntil: channel.exhaustedUntil,
    lastResponseMs: channel.latencyMs,
  }))
}

async function handleRelayRoute(
  adapter: ProviderAdapter,
  request: Request,
  options: GatewayAppOptions,
  env: GatewayEnv | undefined,
  ctx: GatewayExecutionContext,
  store: GatewayStore,
  pepper: string | undefined,
  now: string
): Promise<Response> {
  if (!pepper) throw new GatewayError('server_pepper_not_configured', 500)
  const { accountId, apiKeyId } = await authenticateBuyer(request, store, pepper, now)
  return handleRelayForAccount({
    adapter,
    request,
    options,
    env,
    ctx,
    store,
    accountId,
    apiKeyId,
    now,
  })
}

async function handleRelayForAccount(input: {
  adapter: ProviderAdapter
  request: Request
  options: GatewayAppOptions
  env: GatewayEnv | undefined
  ctx: GatewayExecutionContext
  store: GatewayStore
  accountId: string
  apiKeyId?: string
  now: string
}): Promise<Response> {
  const { adapter, request, options, env, ctx, store, accountId, apiKeyId, now } = input
  const accountRecord = requireActiveAccount(await store.getAccount(accountId))
  const body = await readJsonObject(request)
  const requestedModel =
    typeof body.model === 'string' && body.model.length > 0 ? body.model : accountRecord.defaultModel
  if (!requestedModel) throw new GatewayError('model_required', 400)
  ensureAccountModelAllowed(accountRecord, requestedModel)

  // Multi-tenant isolation: a friend's request only ever routes to its own
  // operator's tokens/rules. Legacy accounts (no operatorId) stay unscoped.
  const operatorId = accountRecord.operatorId ?? undefined
  const routing = resolveRoutingRule({
    accountGroup: accountRecord.accountGroup,
    requestedModel,
    requestedProvider: adapter.name,
    rules: await store.listRoutingRules(operatorId),
    providerTokens: providerTokenSummariesFromChannels(await store.listProviderTokenSummaries(operatorId)),
    now,
  })
  if (routing.providerToken.adapter !== adapter.name) {
    throw new GatewayError('route_provider_adapter_mismatch', 503)
  }
  const providerToken = await store.getProviderToken(routing.providerToken.id)
  if (!providerToken || providerToken.status !== 'active') {
    throw new GatewayError('provider_token_unavailable', 503)
  }

  const envRpmLimit = env?.ACCOUNT_RPM_LIMIT ? Number(env.ACCOUNT_RPM_LIMIT) : NaN
  const rpmLimit =
    options.accountRpmLimit !== undefined
      ? options.accountRpmLimit
      : Number.isFinite(envRpmLimit) && envRpmLimit > 0
        ? envRpmLimit
        : null
  const balance = new AccountBalance({
    accountId: accountRecord.id,
    balanceMicroUsd: accountRecord.balanceMicroUsd,
    rpmLimit,
  })
  const inProcessActor = new InProcessAccountActor(balance, { rpmLimit })
  // env.ACCOUNT_DO is bound in production; tests pass options.store with no
  // env and stay on the in-process actor (no behavior change).
  const account: AccountActor = env?.ACCOUNT_DO
    ? new DurableObjectAccountActor({
        stub: env.ACCOUNT_DO.get(env.ACCOUNT_DO.idFromName(accountRecord.id)),
        accountId: accountRecord.id,
        bootstrapBalanceMicroUsd: accountRecord.balanceMicroUsd,
        rpmLimit,
      })
    : inProcessActor
  const requestId = `req_${crypto.randomUUID()}`
  const upstreamApiKey = await decryptProviderToken(providerToken, getMasterKeys(options, env))
  const priceBook = await store.listPriceBook()
  const fetchImpl = options.fetchImpl ?? fetch
  const isStream = body.stream === true

  try {
    if (isStream) {
      const streamResult = await relayCompletionStream(adapter, {
        account,
        apiKeyId,
        requestId,
        body: { ...body, model: requestedModel },
        routing,
        upstreamApiKey,
        priceBook,
        now,
        fetchImpl,
      })
      const finalizePersist = streamResult.finalize().then(async (final) => {
        const snap = await account.snapshot()
        await store.persistRelayResult({
          accountId: accountRecord.id,
          balanceMicroUsd: snap.balanceMicroUsd,
          requestLog: final.log,
          now,
        })
        await store.updateProviderTokenRuntime({
          providerTokenId: routing.providerToken.id,
          statusCode: streamResult.status,
          latencyMs: final.log.latencyMs,
          now,
        })
      })
      ctx.waitUntil(finalizePersist)
      return streamResult.response
    }

    const result = await relayCompletion(adapter, {
      account,
      apiKeyId,
      requestId,
      body: { ...body, model: requestedModel },
      routing,
      upstreamApiKey,
      priceBook,
      now,
      fetchImpl,
    })
    const snap = await account.snapshot()
    await store.persistRelayResult({
      accountId: accountRecord.id,
      balanceMicroUsd: snap.balanceMicroUsd,
      requestLog: result.log,
      now,
    })
    await store.updateProviderTokenRuntime({
      providerTokenId: routing.providerToken.id,
      statusCode: result.status,
      latencyMs: result.log.latencyMs,
      now,
    })
    return Response.json(result.payload, { status: result.status })
  } catch (error) {
    if (error instanceof GatewayError && error.code.startsWith('provider_http_')) {
      await store.updateProviderTokenRuntime({
        providerTokenId: routing.providerToken.id,
        statusCode: error.status,
        latencyMs: 0,
        now,
      })
    }
    throw error
  }
}

async function handleRequest(
  request: Request,
  options: GatewayAppOptions,
  env?: GatewayEnv,
  ctx: GatewayExecutionContext = fallbackExecutionContext()
): Promise<Response> {
  const url = new URL(request.url)
  const now = (options.now ?? (() => new Date().toISOString()))()
  const store = getStore(options, env)
  const pepper = options.pepper ?? env?.SERVER_PEPPER
  const adminToken = options.adminToken ?? env?.ADMIN_TOKEN
  const adminIpAllowlist = options.adminIpAllowlist ?? env?.ADMIN_IP_ALLOWLIST ?? null

  if (url.pathname === '/health') {
    return json({ ok: true, service: 'mykey-compute-gateway' })
  }

  // Operator self-registration / login. The native app signs a freshness-bound
  // challenge with its locally-held EVM key; the gateway recovers the signer and
  // mints an operator session. No invite link, no global Admin Token.
  if (url.pathname === '/operator/register' && request.method === 'POST') {
    const body = await readJsonObject(request)
    const address = requireString(body, 'address').toLowerCase()
    await verifyOperatorChallenge({
      address,
      challenge: requireString(body, 'challenge'),
      sig: requireString(body, 'sig'),
      now,
    })
    let operator = await store.findOperatorByAddress(address)
    if (!operator) {
      operator = await store.createOperator({
        id: `op_${crypto.randomUUID()}`,
        pubkeyAddress: address,
        displayName: optionalStringField(body, 'display_name'),
        createdAt: now,
      })
    }
    const session = await mintOperatorSession(store, operator.id, now)
    return json({ operator_id: operator.id, session_token: session.token, expires_at: session.expiresAt }, 201)
  }

  if (url.pathname === '/operator/login' && request.method === 'POST') {
    const body = await readJsonObject(request)
    const address = requireString(body, 'address').toLowerCase()
    await verifyOperatorChallenge({
      address,
      challenge: requireString(body, 'challenge'),
      sig: requireString(body, 'sig'),
      now,
    })
    const operator = await store.findOperatorByAddress(address)
    if (!operator) throw new GatewayError('operator_not_registered', 404)
    if (operator.status !== 'active') throw new GatewayError('operator_disabled', 403)
    const session = await mintOperatorSession(store, operator.id, now)
    return json({ operator_id: operator.id, session_token: session.token, expires_at: session.expiresAt })
  }

  if (url.pathname === '/operator/me' && request.method === 'GET') {
    const operatorId = await authenticateOperator(request, store, now)
    return json({ operator_id: operatorId })
  }

  // --- Operator self-serve (tenant-scoped). All gated by the operator session;
  // writes stamp operator_id, reads filter by it, so operators never see or
  // touch each other's tokens / friends. ---

  if (url.pathname === '/operator/provider-tokens' && request.method === 'POST') {
    const operatorId = await authenticateOperator(request, store, now)
    const body = await readJsonObject(request)
    const provider = requireString(body, 'provider')
    const token = await encryptProviderToken({
      id: optionalStringField(body, 'id') ?? `tok_${crypto.randomUUID()}`,
      provider,
      label: requireString(body, 'label'),
      adapter: optionalStringField(body, 'adapter') ?? provider,
      baseUrl: optionalStringField(body, 'base_url') ?? null,
      plaintext: requireString(body, 'plaintext'),
      masterKeys: getMasterKeys(options, env),
      keyVersion: optionalStringField(body, 'key_version') ?? 'v1',
      now,
    })
    const channel = await store.upsertProviderToken({
      token,
      models: stringArrayField(body, 'models'),
      priority: positiveIntegerField(body, 'priority', 1),
      weight: positiveIntegerField(body, 'weight', 1),
      operatorId,
      now,
    })
    return json({ id: channel.id, label: channel.label, provider: channel.provider, adapter: channel.adapter, models: channel.models, status: channel.status }, 201)
  }

  if (url.pathname === '/operator/provider-tokens' && request.method === 'GET') {
    const operatorId = await authenticateOperator(request, store, now)
    const channels = await store.listProviderTokenSummaries(operatorId)
    return json({ data: channels.map((c) => ({ id: c.id, label: c.label, provider: c.provider, adapter: c.adapter, status: c.status, models: c.models })) })
  }

  if (url.pathname === '/operator/routing-rules' && request.method === 'POST') {
    const operatorId = await authenticateOperator(request, store, now)
    const body = await readJsonObject(request)
    const saved = await store.upsertRoutingRule({
      rule: {
        id: optionalStringField(body, 'id') ?? `route_${crypto.randomUUID()}`,
        accountGroup: optionalStringField(body, 'account_group') ?? 'default',
        requestedProvider: optionalStringField(body, 'requested_provider'),
        requestedModel: requireString(body, 'requested_model'),
        providerTokenId: requireString(body, 'provider_token_id'),
        actualProviderModel: optionalStringField(body, 'actual_provider_model') ?? requireString(body, 'requested_model'),
        priority: integerField(body, 'priority', 0),
        weight: positiveIntegerField(body, 'weight', 1),
        status: optionalStringField(body, 'status') === 'disabled' ? 'disabled' : 'active',
        operatorId,
      },
      now,
    })
    return json({ id: saved.id, account_group: saved.accountGroup, requested_model: saved.requestedModel, provider_token_id: saved.providerTokenId, status: saved.status }, 201)
  }

  if (url.pathname === '/operator/routing-rules' && request.method === 'GET') {
    const operatorId = await authenticateOperator(request, store, now)
    const rules = await store.listRoutingRules(operatorId)
    return json({
      data: rules.map((r) => ({
        id: r.id,
        account_group: r.accountGroup,
        requested_provider: r.requestedProvider ?? null,
        requested_model: r.requestedModel,
        provider_token_id: r.providerTokenId,
        status: r.status,
      })),
    })
  }

  // Pricing stays platform-shared (not operator-isolated) for now.
  if (url.pathname === '/operator/price-book' && request.method === 'POST') {
    await authenticateOperator(request, store, now)
    const body = await readJsonObject(request)
    const saved = await store.upsertPriceBook({
      row: {
        id: optionalStringField(body, 'id') ?? `price_${crypto.randomUUID()}`,
        version: positiveIntegerField(body, 'version', 1),
        provider: requireString(body, 'provider'),
        model: requireString(body, 'model'),
        sellInputMicroUsdPer1MTokens: positiveIntegerField(body, 'sell_input_micro_usd_per_1m_tokens'),
        sellOutputMicroUsdPer1MTokens: positiveIntegerField(body, 'sell_output_micro_usd_per_1m_tokens'),
        upstreamInputMicroUsdPer1MTokens: positiveIntegerField(body, 'upstream_input_micro_usd_per_1m_tokens'),
        upstreamOutputMicroUsdPer1MTokens: positiveIntegerField(body, 'upstream_output_micro_usd_per_1m_tokens'),
        validFrom: optionalStringField(body, 'valid_from') ?? now,
        validTo: optionalStringField(body, 'valid_to') ?? null,
        enabled: booleanField(body, 'enabled', true),
      },
      now,
    })
    return json({ id: saved.id, provider: saved.provider, model: saved.model }, 201)
  }

  if (url.pathname === '/operator/accounts' && request.method === 'POST') {
    const operatorId = await authenticateOperator(request, store, now)
    const body = await readJsonObject(request)
    const modelAllowlist = optionalStringArrayField(body, 'model_allowlist')
    const account = await store.createAccount({
      id: optionalStringField(body, 'id') ?? `acct_${crypto.randomUUID()}`,
      displayName: requireString(body, 'display_name'),
      status: 'active',
      accountGroup: optionalStringField(body, 'account_group') ?? 'default',
      operatorId,
      balanceMicroUsd: 0,
      reservedMicroUsd: 0,
      defaultProvider: optionalStringField(body, 'default_provider') ?? 'openai',
      defaultModel: optionalStringField(body, 'default_model'),
      modelAllowlist: modelAllowlist ?? null,
      createdAt: now,
      updatedAt: now,
    })
    return json({ id: account.id, display_name: account.displayName, account_group: account.accountGroup, balance_micro_usd: account.balanceMicroUsd, model_allowlist: account.modelAllowlist ?? [] }, 201)
  }

  if (url.pathname === '/operator/accounts' && request.method === 'GET') {
    const operatorId = await authenticateOperator(request, store, now)
    const accounts = await store.listAccounts(operatorId)
    return json({ data: accounts.map((a) => ({ id: a.id, display_name: a.displayName, status: a.status, account_group: a.accountGroup, balance_micro_usd: a.balanceMicroUsd, default_model: a.defaultModel ?? null, model_allowlist: a.modelAllowlist ?? [] })) })
  }

  const operatorAccountUpdateMatch = /^\/operator\/accounts\/([^/]+)$/.exec(url.pathname)
  if (operatorAccountUpdateMatch && request.method === 'PATCH') {
    const operatorId = await authenticateOperator(request, store, now)
    const account = await store.getAccount(operatorAccountUpdateMatch[1])
    if (!account || account.operatorId !== operatorId) throw new GatewayError('account_not_found', 404)
    const body = await readJsonObject(request)
    const updated = await store.updateAccount({
      accountId: account.id,
      displayName: optionalStringField(body, 'display_name'),
      defaultModel: optionalStringField(body, 'default_model'),
      modelAllowlist: optionalStringArrayField(body, 'model_allowlist'),
      now,
    })
    if (!updated) throw new GatewayError('account_not_found', 404)
    return json({
      id: updated.id,
      display_name: updated.displayName,
      account_group: updated.accountGroup,
      balance_micro_usd: updated.balanceMicroUsd,
      default_model: updated.defaultModel ?? null,
      model_allowlist: updated.modelAllowlist ?? [],
      status: updated.status,
    })
  }

  if (url.pathname === '/operator/invites' && request.method === 'GET') {
    const operatorId = await authenticateOperator(request, store, now)
    const invites = await store.listInvites({ operatorId })
    const accounts = new Map((await store.listAccounts(operatorId)).map((account) => [account.id, account]))
    return json({
      data: invites.map((invite) => {
        const account = accounts.get(invite.accountId)
        return {
          id: invite.id,
          account_id: invite.accountId,
          account_display_name: account?.displayName ?? invite.accountId,
          account_group: account?.accountGroup ?? 'default',
          status: invite.status,
          expires_at: invite.expiresAt,
          created_at: invite.createdAt,
          accepted_at: invite.acceptedAt ?? null,
        }
      }),
    })
  }

  const operatorInviteRevokeMatch = /^\/operator\/invites\/([^/]+)\/revoke$/.exec(url.pathname)
  if (operatorInviteRevokeMatch && request.method === 'POST') {
    const operatorId = await authenticateOperator(request, store, now)
    const inviteId = operatorInviteRevokeMatch[1]
    const ownInvite = (await store.listInvites({ operatorId })).find((invite) => invite.id === inviteId)
    if (!ownInvite) throw new GatewayError('invite_not_found', 404)
    const revoked = await store.revokeInvite(inviteId, now)
    if (!revoked) throw new GatewayError('invite_not_found', 404)
    // Cut the friend off, not just the link: disabling the account blocks all
    // relay (API key + web AI 对话, via requireActiveAccount) and the dashboard
    // (authenticateDashboard checks status). Otherwise an already-accepted friend
    // keeps their session + API keys and the revoke does nothing to live access.
    await store.updateAccount({ accountId: revoked.accountId, status: 'disabled', now })
    return json({
      id: revoked.id,
      account_id: revoked.accountId,
      status: revoked.status,
      account_status: 'disabled',
      expires_at: revoked.expiresAt,
      created_at: revoked.createdAt,
      accepted_at: revoked.acceptedAt ?? null,
    })
  }

  const operatorInviteMatch = /^\/operator\/accounts\/([^/]+)\/invites$/.exec(url.pathname)
  if (operatorInviteMatch && request.method === 'POST') {
    const operatorId = await authenticateOperator(request, store, now)
    const account = await store.getAccount(operatorInviteMatch[1])
    // 404 (not 403) when the account isn't this operator's — don't leak existence.
    if (!account || account.operatorId !== operatorId) throw new GatewayError('account_not_found', 404)
    const { invite, rawToken } = createInviteToken({ accountId: account.id, createdBy: `operator:${operatorId}`, now })
    await store.createInvite(invite)
    const inviteUrl = `${options.baseUrl ?? new URL(request.url).origin}/accept?token=${encodeURIComponent(rawToken)}&autocreate_key=1&tab=keys`
    return json({ invite_id: invite.id, invite_token: rawToken, invite_url: inviteUrl, expires_at: invite.expiresAt }, 201)
  }

  const operatorCreditMatch = /^\/operator\/accounts\/([^/]+)\/manual-credit$/.exec(url.pathname)
  if (operatorCreditMatch && request.method === 'POST') {
    const operatorId = await authenticateOperator(request, store, now)
    const account = await store.getAccount(operatorCreditMatch[1])
    if (!account || account.operatorId !== operatorId) throw new GatewayError('account_not_found', 404)
    const body = await readJsonObject(request)
    const amount = Number(body.amount_micro_usd)
    if (!Number.isInteger(amount) || amount <= 0) throw new GatewayError('invalid_credit_amount', 400)
    const credited = await store.manualCredit(account.id, amount, now)
    return json({ account_id: credited.id, balance_micro_usd: credited.balanceMicroUsd })
  }

  // Operator income view: real treasury (USDC collected − already withdrawn) and
  // the accounting compute margin Σ(sell − upstream). Scoped to this operator.
  if (url.pathname === '/operator/revenue' && request.method === 'GET') {
    const operatorId = await authenticateOperator(request, store, now)
    const revenue = await store.getOperatorRevenue(operatorId)
    const withdrawable = Math.max(0, revenue.treasuryCreditedMicroUsd - revenue.treasuryWithdrawnMicroUsd)
    // Stablecoin meta is best-effort: the panel still renders if it's unconfigured.
    let stablecoin: { token_address: string; chain_id: number; decimals: number } | null = null
    try {
      const config = getStablecoinConfig(env)
      stablecoin = {
        token_address: config.tokenAddress,
        chain_id: env?.TEMPO_CHAIN_ID ? Number(env.TEMPO_CHAIN_ID) : 11155111,
        decimals: 6,
      }
    } catch {
      stablecoin = null
    }
    return json({
      treasury: {
        credited_micro_usd: revenue.treasuryCreditedMicroUsd,
        withdrawn_micro_usd: revenue.treasuryWithdrawnMicroUsd,
        withdrawable_micro_usd: withdrawable,
      },
      margin: {
        sell_micro_usd: revenue.sellMicroUsd,
        upstream_micro_usd: revenue.upstreamMicroUsd,
        margin_micro_usd: revenue.marginMicroUsd,
        calls: revenue.calls,
        total_tokens: revenue.totalTokens,
      },
      stablecoin,
    })
  }

  // Withdraw collected USDC to the operator's own wallet. Capped at this
  // operator's withdrawable share so one tenant can never drain the shared
  // relayer pool that holds every operator's collected funds.
  if (url.pathname === '/operator/treasury/withdraw' && request.method === 'POST') {
    const operatorId = await authenticateOperator(request, store, now)
    const body = await readJsonObject(request)
    const toAddress = requireString(body, 'to_address')
    if (!/^0x[0-9a-fA-F]{40}$/.test(toAddress)) throw new GatewayError('invalid_address', 400)
    const revenue = await store.getOperatorRevenue(operatorId)
    const withdrawable = Math.max(0, revenue.treasuryCreditedMicroUsd - revenue.treasuryWithdrawnMicroUsd)
    // Default: sweep the whole withdrawable balance. An explicit amount must be a
    // positive integer (µUSD) within that cap.
    const requested = body.amount_micro_usd === undefined ? withdrawable : Number(body.amount_micro_usd)
    if (!Number.isInteger(requested) || requested <= 0) throw new GatewayError('invalid_withdraw_amount', 400)
    if (requested > withdrawable) throw new GatewayError('withdraw_exceeds_balance', 400)
    const config = getStablecoinConfig(env)
    const txHash = await (options.relayer?.withdrawToken ?? relayerWithdrawToken)(env, {
      tokenAddress: config.tokenAddress,
      to: toAddress,
      value: BigInt(requested),
    })
    await store.recordTreasuryWithdrawal({
      id: `twd_${crypto.randomUUID()}`,
      operatorId,
      amountMicroUsd: requested,
      toAddress,
      txHash,
      createdAt: now,
    })
    return json({
      tx_hash: txHash,
      withdrawn_micro_usd: requested,
      to_address: toAddress,
      remaining_withdrawable_micro_usd: withdrawable - requested,
    })
  }

  // Browser-facing invite landing. Friend clicks `<gateway>/accept?token=...`
  // from a bootstrap-generated invite URL → we mint a dashboard session,
  // drop a cookie, and 302 them at the SPA root. POST /dashboard/invites/accept
  // remains the JSON path for programmatic use.
  if (url.pathname === '/accept' && request.method === 'GET') {
    const inviteToken = url.searchParams.get('token')
    if (!inviteToken) throw new GatewayError('invite_token_required', 400)
    const invite = await store.findInviteByHash(hashDashboardToken(inviteToken))
    if (!invite) throw new GatewayError('invite_not_found', 404)
    if (invite.status !== 'active') throw new GatewayError('invite_not_active', 409)
    if (Date.parse(invite.expiresAt) <= Date.parse(now)) throw new GatewayError('invite_expired', 410)
    await store.markInviteAccepted(invite.id, now)
    const session = createDashboardSession({
      accountId: invite.accountId,
      authMethod: 'magic_link',
      now,
    })
    await store.createDashboardSession({
      id: session.id,
      accountId: session.accountId,
      sessionHash: session.sessionHash,
      authMethod: session.authMethod,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    })
    if (parseBooleanQueryParam(url.searchParams.get('autocreate_key'))) {
      await ensureInviteDashboardApiKey(store, invite.accountId, pepper, now)
    }
    const cookie = [
      `mykey_dashboard_session=${session.sessionToken}`,
      'Path=/',
      'HttpOnly',
      'Secure',
      'SameSite=Strict',
      `Expires=${new Date(session.expiresAt).toUTCString()}`,
    ].join('; ')
    const location = buildAcceptRedirectLocation(url.searchParams)
    return new Response(null, {
      status: 302,
      headers: { location, 'set-cookie': cookie },
    })
  }

  if (url.pathname === '/dashboard/invites/accept' && request.method === 'POST') {
    const body = await readJsonObject(request)
    const inviteToken = requireString(body, 'invite_token')
    const invite = await store.findInviteByHash(hashDashboardToken(inviteToken))
    if (!invite) throw new GatewayError('invite_not_found', 404)
    if (invite.status !== 'active') throw new GatewayError('invite_not_active', 409)
    if (Date.parse(invite.expiresAt) <= Date.parse(now)) throw new GatewayError('invite_expired', 410)
    await store.markInviteAccepted(invite.id, now)
    const session = createDashboardSession({
      accountId: invite.accountId,
      authMethod: 'magic_link',
      now,
    })
    await store.createDashboardSession({
      id: session.id,
      accountId: session.accountId,
      sessionHash: session.sessionHash,
      authMethod: session.authMethod,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    })
    const cookie = [
      `mykey_dashboard_session=${session.sessionToken}`,
      'Path=/',
      'HttpOnly',
      'Secure',
      'SameSite=Strict',
      `Expires=${new Date(session.expiresAt).toUTCString()}`,
    ].join('; ')
    return new Response(
      JSON.stringify({
        account_id: session.accountId,
        session_token: session.sessionToken,
        expires_at: session.expiresAt,
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': cookie,
        },
      }
    )
  }

  if (url.pathname === '/dashboard/me' && request.method === 'GET') {
    const accountId = await authenticateDashboard(request, store, now)
    return json(await store.getDashboardSnapshot(accountId))
  }

  if (url.pathname === '/dashboard/api-keys' && request.method === 'POST') {
    const accountId = await authenticateDashboard(request, store, now)
    if (!pepper) throw new GatewayError('server_pepper_not_configured', 500)
    const body = await readJsonObject(request).catch(() => ({}))
    const environment = optionalStringField(body, 'environment') === 'test' ? 'test' : 'live'
    const created = createApiKey({ environment })
    const apiKey = registerApiKey({
      id: `key_${crypto.randomUUID()}`,
      accountId,
      rawKey: created.rawKey,
      pepper,
      now,
      name: optionalStringField(body, 'name'),
    })
    await store.createApiKeyRecord(apiKey)
    return json(
      {
        id: apiKey.id,
        account_id: apiKey.accountId,
        name: apiKey.name,
        raw_key: created.rawKey,
        prefix: apiKey.keyPrefix,
        last4: apiKey.keyLast4,
        scope: apiKey.scope,
        status: apiKey.status,
        created_at: apiKey.createdAt,
      },
      201
    )
  }

  const dashboardRevokeMatch = /^\/dashboard\/api-keys\/([^/]+)\/revoke$/.exec(url.pathname)
  if (dashboardRevokeMatch && request.method === 'POST') {
    const accountId = await authenticateDashboard(request, store, now)
    const apiKey = await store.findApiKeyById(dashboardRevokeMatch[1])
    if (!apiKey || apiKey.accountId !== accountId) throw new GatewayError('api_key_not_found', 404)
    if (apiKey.status === 'revoked') {
      return json({
        id: apiKey.id,
        account_id: apiKey.accountId,
        status: apiKey.status,
        revoked_at: apiKey.revokedAt ?? now,
      })
    }
    const revoked = await store.revokeApiKey(apiKey.id, now)
    if (!revoked) throw new GatewayError('api_key_not_found', 404)
    return json({
      id: revoked.id,
      account_id: revoked.accountId,
      status: revoked.status,
      revoked_at: revoked.revokedAt,
    })
  }

  if (url.pathname === '/dashboard/balance' && request.method === 'GET') {
    const accountId = await authenticateDashboard(request, store, now)
    const account = await store.getAccount(accountId)
    if (!account) throw new GatewayError('account_not_found', 404)
    return json({
      account_id: account.id,
      balance_micro_usd: account.balanceMicroUsd,
      reserved_micro_usd: account.reservedMicroUsd,
      available_micro_usd: account.balanceMicroUsd - account.reservedMicroUsd,
    })
  }

  if (url.pathname === '/dashboard/usage' && request.method === 'GET') {
    const accountId = await authenticateDashboard(request, store, now)
    return json({ data: await store.listUsage(accountId) })
  }

  // Red-packet claim: buyer submits a claim code + their wallet address. The
  // relayer transfers MYC from its pool to the address. User mints nothing,
  // pays no gas.
  if (url.pathname === '/dashboard/claim' && request.method === 'POST') {
    const accountId = await authenticateDashboard(request, store, now)
    const body = await readJsonObject(request)
    const code = requireString(body, 'code')
    const toAddress = requireString(body, 'to_address')
    if (!/^0x[0-9a-fA-F]{40}$/.test(toAddress)) throw new GatewayError('invalid_address', 400)
    const packet = await store.getRedpacketByCodeHash(await sha256Hex(code))
    if (!packet) throw new GatewayError('redpacket_not_found', 404)
    if (packet.status !== 'unclaimed') throw new GatewayError('redpacket_already_claimed', 409)
    // Win the claim atomically BEFORE transferring, so two concurrent requests
    // with the same code can't both pull from the relayer pool. The loser gets
    // 409; if the on-chain transfer then fails we release it back to unclaimed.
    const won = await store.claimRedpacket({ id: packet.id, account: accountId, toAddress, now })
    if (!won) throw new GatewayError('redpacket_already_claimed', 409)
    let txHash: string
    try {
      txHash = await (options.relayer?.transfer ?? relayerTransfer)(env, toAddress, BigInt(packet.amountRaw))
    } catch (e) {
      await store.revertRedpacketClaim({ id: packet.id })
      throw e
    }
    await store.setRedpacketClaimTx({ id: packet.id, txHash })
    return json({ tx_hash: txHash, amount_myc: Number(packet.amountRaw) / 1e6, to_address: toAddress })
  }

  // Gasless redeem: buyer signs a burnWithSig authorization (no gas). The
  // relayer submits it on-chain (pays gas); then we verify the burn and credit.
  if (url.pathname === '/dashboard/redeem-gasless' && request.method === 'POST') {
    const accountId = await authenticateDashboard(request, store, now)
    const body = await readJsonObject(request)
    const from = requireString(body, 'from')
    const value = BigInt(requireString(body, 'value'))
    const memo = requireString(body, 'memo') as `0x${string}`
    const deadline = BigInt(requireString(body, 'deadline'))
    const sig = requireString(body, 'sig') as `0x${string}`
    const txHash = await (options.relayer?.burnWithSig ?? relayerBurnWithSig)(env, { from, value, memo, deadline, sig })
    const result = await verifyAndCreditBurn({ store, config: getTopupConfig(env), txHash, accountId, now, fetchImpl: options.fetchImpl })
    return json({
      tx_hash: txHash,
      credited_micro_usd: result.creditedMicroUsd,
      balance_micro_usd: result.balanceMicroUsd,
      burned_myc: Number(result.burn.amountRaw) / 1e6,
    })
  }

  // Gasless MYC transfer between friends. The sender signs a transferWithSig
  // authorization with their passkey wallet; the relayer submits it and pays gas
  // — the sender never needs ETH and never sees the chain. Wallet→wallet only;
  // the recipient later redeems the received MYC to credit their account.
  if (url.pathname === '/dashboard/transfer-gasless' && request.method === 'POST') {
    await authenticateDashboard(request, store, now)
    const body = await readJsonObject(request)
    const from = requireString(body, 'from') as `0x${string}`
    const to = requireString(body, 'to') as `0x${string}`
    const value = BigInt(requireString(body, 'value'))
    if (value <= 0n) throw new GatewayError('invalid_value', 400)
    const deadline = BigInt(requireString(body, 'deadline'))
    const sig = requireString(body, 'sig') as `0x${string}`
    const txHash = await (options.relayer?.transferWithSig ?? relayerTransferWithSig)(env, {
      from,
      to,
      value,
      deadline,
      sig,
    })
    return json({ tx_hash: txHash, transferred_myc: Number(value) / 1e6, to_address: to })
  }

  // On-chain config the buyer's wallet needs to sign authorizations: the
  // stablecoin token address and the relayer sink it must pay (the transferWithSig
  // digest binds `to`, so the client must sign to the exact relayer address). Kept
  // here (not in the dashboard snapshot) because it's derived from Worker env.
  if (url.pathname === '/dashboard/onchain-config' && request.method === 'GET') {
    await authenticateDashboard(request, store, now)
    const chainId = env?.TEMPO_CHAIN_ID ? Number(env.TEMPO_CHAIN_ID) : 11155111
    let stablecoinToken: string | null = null
    let faucetEnabled = false
    try {
      const sc = getStablecoinConfig(env)
      stablecoinToken = sc.tokenAddress
      faucetEnabled = sc.faucetEnabled
    } catch {
      /* stablecoin not configured — USDT purchase unavailable */
    }
    let relayer: string | null = null
    try {
      relayer = (options.relayer?.address ?? relayerAddress)(env)
    } catch {
      /* relayer not configured */
    }
    return json({
      chain_id: chainId,
      myc_token: env?.MYC_TOKEN_ADDRESS ?? null,
      stablecoin_token: stablecoinToken,
      stablecoin_decimals: 6,
      relayer_address: relayer,
      faucet_enabled: faucetEnabled,
    })
  }

  // Buy MYC with stablecoin (USDT), fully gasless. The buyer signs a stablecoin
  // transferWithSig paying the relayer; the relayer submits it (pays gas) and
  // then hands back MYC at the configured rate. The buyer then redeems that MYC
  // to credit via /dashboard/redeem-gasless. No ETH ever needed by the buyer.
  if (url.pathname === '/dashboard/buy-myc' && request.method === 'POST') {
    const accountId = await authenticateDashboard(request, store, now)
    const body = await readJsonObject(request)
    const from = requireString(body, 'from') as `0x${string}`
    if (!/^0x[0-9a-fA-F]{40}$/.test(from)) throw new GatewayError('invalid_address', 400)
    const value = BigInt(requireString(body, 'value'))
    if (value <= 0n) throw new GatewayError('invalid_value', 400)
    const deadline = BigInt(requireString(body, 'deadline'))
    const sig = requireString(body, 'sig') as `0x${string}`
    const config = getStablecoinConfig(env)
    const sink = (options.relayer?.address ?? relayerAddress)(env)
    // 1) Pull the stablecoin from the buyer to the relayer (replay-protected
    //    on-chain by the token's nonce; a resubmitted request reverts here).
    const payTxHash = await (options.relayer?.transferWithSig ?? relayerTransferWithSig)(env, {
      from,
      to: sink,
      value,
      deadline,
      sig,
      tokenAddress: config.tokenAddress,
    })
    // 2) Hand back MYC at the configured rate. If this fails after the buyer
    //    paid, the payTxHash is the on-chain receipt for operator reconciliation.
    const mycRaw = stablecoinToMycRaw(value, config.mycRate)
    const mycTxHash = await (options.relayer?.transfer ?? relayerTransfer)(env, from, mycRaw)
    // Attribute the USDC paid into the shared relayer to the operator that owns
    // this buyer, so it counts toward exactly their withdrawable treasury.
    // Idempotent on payTxHash; skipped for legacy/unscoped accounts (no owner).
    const buyerAccount = await store.getAccount(accountId)
    if (buyerAccount?.operatorId) {
      await store.recordTreasuryCredit({
        id: `tcr_${crypto.randomUUID()}`,
        operatorId: buyerAccount.operatorId,
        accountId,
        amountMicroUsd: Number(value),
        stablecoinTxHash: payTxHash,
        createdAt: now,
      })
    }
    return json({
      stablecoin_tx_hash: payTxHash,
      tx_hash: mycTxHash,
      paid_usdt: Number(value) / 1e6,
      bought_myc: Number(mycRaw) / 1e6,
      to_address: from,
    })
  }

  // Testnet faucet: mint test-USDT to a wallet so the buy-MYC flow can be
  // exercised end to end without real funds. Disabled on mainnet.
  if (url.pathname === '/dashboard/faucet-usdt' && request.method === 'POST') {
    await authenticateDashboard(request, store, now)
    const body = await readJsonObject(request)
    const toAddress = requireString(body, 'to_address')
    if (!/^0x[0-9a-fA-F]{40}$/.test(toAddress)) throw new GatewayError('invalid_address', 400)
    const config = getStablecoinConfig(env)
    if (!config.faucetEnabled) throw new GatewayError('faucet_disabled', 403)
    const txHash = await (options.relayer?.mint ?? relayerMint)(env, {
      tokenAddress: config.tokenAddress,
      to: toAddress,
      value: config.faucetAmountRaw,
    })
    return json({ tx_hash: txHash, minted_usdt: Number(config.faucetAmountRaw) / 1e6, to_address: toAddress })
  }

  // Self-service MYC top-up: buyer burns MYC on Tempo, then submits the tx hash
  // here. We verify the burn on-chain (read-only) and credit their balance.
  if (url.pathname === '/dashboard/topup' && request.method === 'POST') {
    const accountId = await authenticateDashboard(request, store, now)
    const body = await readJsonObject(request)
    const txHash = requireString(body, 'tx_hash')
    const result = await verifyAndCreditBurn({
      store,
      config: getTopupConfig(env),
      txHash,
      accountId,
      now,
      fetchImpl: options.fetchImpl,
    })
    return json({
      tx_hash: txHash,
      credited_micro_usd: result.creditedMicroUsd,
      balance_micro_usd: result.balanceMicroUsd,
      burned_myc_raw: result.burn.amountRaw.toString(),
    })
  }

  if (url.pathname === '/dashboard/credit-requests' && request.method === 'POST') {
    const accountId = await authenticateDashboard(request, store, now)
    const body = await readJsonObject(request)
    const requested = positiveIntegerField(body, 'requested_micro_usd')
    const message = optionalStringField(body, 'message')
    const record: CreditRequestRecord = {
      id: `crq_${crypto.randomUUID()}`,
      accountId,
      requestedMicroUsd: requested,
      message,
      status: 'pending',
      createdAt: now,
    }
    await store.createCreditRequest(record)
    return json(serializeCreditRequest(record), 201)
  }

  if (url.pathname === '/dashboard/credit-requests' && request.method === 'GET') {
    const accountId = await authenticateDashboard(request, store, now)
    const records = await store.listCreditRequests({ accountId })
    return json({ data: records.map(serializeCreditRequest) })
  }

  if (url.pathname === '/dashboard/responses' && request.method === 'POST') {
    const accountId = await authenticateDashboard(request, store, now)
    return handleRelayForAccount({
      adapter: openAIAdapter,
      request,
      options,
      env,
      ctx,
      store,
      accountId,
      now,
    })
  }

  if (url.pathname === '/dashboard/chat/completions' && request.method === 'POST') {
    const accountId = await authenticateDashboard(request, store, now)
    return handleRelayForAccount({
      adapter: openAIChatCompletionsAdapter,
      request,
      options,
      env,
      ctx,
      store,
      accountId,
      now,
    })
  }

  // Anthropic-format counterpart so the web AI chat can reach anthropic-compat
  // channels that the OpenAI-compatible adapters reject.
  if (url.pathname === '/dashboard/messages' && request.method === 'POST') {
    const accountId = await authenticateDashboard(request, store, now)
    return handleRelayForAccount({
      adapter: anthropicAdapter,
      request,
      options,
      env,
      ctx,
      store,
      accountId,
      now,
    })
  }

  if (url.pathname === '/v1/balance' && request.method === 'GET') {
    if (!pepper) throw new GatewayError('server_pepper_not_configured', 500)
    const { accountId } = await authenticateBuyer(request, store, pepper, now)
    const account = await store.getAccount(accountId)
    if (!account) throw new GatewayError('account_not_found', 404)
    return json({
      account_id: account.id,
      balance_micro_usd: account.balanceMicroUsd,
      reserved_micro_usd: account.reservedMicroUsd,
      available_micro_usd: account.balanceMicroUsd - account.reservedMicroUsd,
    })
  }

  if (url.pathname === '/v1/usage' && request.method === 'GET') {
    if (!pepper) throw new GatewayError('server_pepper_not_configured', 500)
    const { accountId } = await authenticateBuyer(request, store, pepper, now)
    return json({ data: await store.listUsage(accountId) })
  }

  if (url.pathname === '/v1/models' && request.method === 'GET') {
    if (!pepper) throw new GatewayError('server_pepper_not_configured', 500)
    const { accountId } = await authenticateBuyer(request, store, pepper, now)
    const models = await store.listModels(accountId)
    return json({
      object: 'list',
      data: models.map((model) => ({ id: model, object: 'model', owned_by: 'mykey' })),
    })
  }

  if (url.pathname === '/v1/responses' && request.method === 'POST') {
    return handleRelayRoute(openAIAdapter, request, options, env, ctx, store, pepper, now)
  }

  if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
    return handleRelayRoute(openAIChatCompletionsAdapter, request, options, env, ctx, store, pepper, now)
  }

  if (url.pathname === '/v1/messages' && request.method === 'POST') {
    return handleRelayRoute(anthropicAdapter, request, options, env, ctx, store, pepper, now)
  }

  if (url.pathname === '/admin/accounts' && request.method === 'GET') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const accounts = await store.listAccounts()
    return json({
      data: accounts.map((account) => ({
        id: account.id,
        display_name: account.displayName,
        status: account.status,
        account_group: account.accountGroup,
        balance_micro_usd: account.balanceMicroUsd,
        reserved_micro_usd: account.reservedMicroUsd,
        default_provider: account.defaultProvider,
        default_model: account.defaultModel,
        created_at: account.createdAt,
        updated_at: account.updatedAt,
      })),
    })
  }

  if (url.pathname === '/admin/accounts' && request.method === 'POST') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const body = await readJsonObject(request)
    const account = await store.createAccount({
      id: optionalStringField(body, 'id') ?? `acct_${crypto.randomUUID()}`,
      displayName: requireString(body, 'display_name'),
      status:
        optionalStringField(body, 'status') === 'paused'
          ? 'paused'
          : optionalStringField(body, 'status') === 'disabled'
            ? 'disabled'
            : 'active',
      accountGroup: optionalStringField(body, 'account_group') ?? 'default',
      balanceMicroUsd: 0,
      reservedMicroUsd: 0,
      defaultProvider: optionalStringField(body, 'default_provider') ?? 'openai',
      defaultModel: optionalStringField(body, 'default_model'),
      createdAt: now,
      updatedAt: now,
    })
    await recordAuditAdminAction(store, {
      action: 'admin.account.create',
      targetType: 'account',
      targetId: account.id,
      body,
      statusCode: 201,
      now,
    })
    return json(
      {
        id: account.id,
        display_name: account.displayName,
        status: account.status,
        account_group: account.accountGroup,
        balance_micro_usd: account.balanceMicroUsd,
        default_provider: account.defaultProvider,
        default_model: account.defaultModel,
        created_at: account.createdAt,
        updated_at: account.updatedAt,
      },
      201
    )
  }

  const manualCreditMatch = /^\/admin\/accounts\/([^/]+)\/manual-credit$/.exec(url.pathname)
  if (manualCreditMatch && request.method === 'POST') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const body = await readJsonObject(request)
    const amount = Number(body.amount_micro_usd)
    if (!Number.isInteger(amount) || amount <= 0) throw new GatewayError('invalid_credit_amount', 400)
    const account = await store.manualCredit(manualCreditMatch[1], amount, now)
    await recordAuditAdminAction(store, {
      action: 'admin.account.credit',
      targetType: 'account',
      targetId: manualCreditMatch[1],
      body,
      statusCode: 200,
      now,
    })
    return json({
      account_id: account.id,
      balance_micro_usd: account.balanceMicroUsd,
      updated_at: account.updatedAt,
    })
  }

  const creditFromBurnMatch = /^\/admin\/accounts\/([^/]+)\/credit-from-burn$/.exec(url.pathname)
  if (creditFromBurnMatch && request.method === 'POST') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const body = await readJsonObject(request)
    const txHash = requireString(body, 'tx_hash')
    const result = await verifyAndCreditBurn({
      store,
      config: getTopupConfig(env),
      txHash,
      accountId: creditFromBurnMatch[1],
      now,
      fetchImpl: options.fetchImpl,
    })
    await recordAuditAdminAction(store, {
      action: 'admin.account.credit_from_burn',
      targetType: 'account',
      targetId: creditFromBurnMatch[1],
      body,
      statusCode: 200,
      now,
      extra: { credited_micro_usd: result.creditedMicroUsd, burned_myc_raw: result.burn.amountRaw.toString() },
    })
    return json({
      account_id: creditFromBurnMatch[1],
      tx_hash: txHash,
      credited_micro_usd: result.creditedMicroUsd,
      balance_micro_usd: result.balanceMicroUsd,
      burned_myc_raw: result.burn.amountRaw.toString(),
      memo: result.burn.memo,
    })
  }

  if (url.pathname === '/admin/credit-requests' && request.method === 'GET') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const statusParam = url.searchParams.get('status')
    const statusFilter: CreditRequestStatus | undefined =
      statusParam === 'pending' || statusParam === 'approved' || statusParam === 'rejected' ? statusParam : undefined
    const records = await store.listCreditRequests({ statusFilter })
    return json({ data: records.map(serializeCreditRequest) })
  }

  const approveCreditRequestMatch = /^\/admin\/credit-requests\/([^/]+)\/approve$/.exec(url.pathname)
  if (approveCreditRequestMatch && request.method === 'POST') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const existing = await store.getCreditRequest(approveCreditRequestMatch[1])
    if (!existing) throw new GatewayError('credit_request_not_found', 404)
    const result = await store.resolveCreditRequest({
      id: approveCreditRequestMatch[1],
      decision: 'approve',
      resolvedBy: 'admin',
      now,
    })
    const statusCode = result.ok ? 200 : 409
    await recordAuditAdminAction(store, {
      action: 'admin.credit_request.approve',
      targetType: 'credit_request',
      targetId: approveCreditRequestMatch[1],
      statusCode,
      now,
      extra: { decision_ok: result.ok, account_id: existing.accountId, amount_micro_usd: existing.requestedMicroUsd },
    })
    if (!result.ok) {
      return new Response(JSON.stringify(serializeCreditRequest(result.record)), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })
    }
    return json(serializeCreditRequest(result.record))
  }

  const rejectCreditRequestMatch = /^\/admin\/credit-requests\/([^/]+)\/reject$/.exec(url.pathname)
  if (rejectCreditRequestMatch && request.method === 'POST') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const existing = await store.getCreditRequest(rejectCreditRequestMatch[1])
    if (!existing) throw new GatewayError('credit_request_not_found', 404)
    const result = await store.resolveCreditRequest({
      id: rejectCreditRequestMatch[1],
      decision: 'reject',
      resolvedBy: 'admin',
      now,
    })
    const statusCode = result.ok ? 200 : 409
    await recordAuditAdminAction(store, {
      action: 'admin.credit_request.reject',
      targetType: 'credit_request',
      targetId: rejectCreditRequestMatch[1],
      statusCode,
      now,
      extra: { decision_ok: result.ok, account_id: existing.accountId },
    })
    if (!result.ok) {
      return new Response(JSON.stringify(serializeCreditRequest(result.record)), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })
    }
    return json(serializeCreditRequest(result.record))
  }

  const createInviteMatch = /^\/admin\/accounts\/([^/]+)\/invites$/.exec(url.pathname)
  if (createInviteMatch && request.method === 'POST') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const account = await store.getAccount(createInviteMatch[1])
    if (!account) throw new GatewayError('account_not_found', 404)
    const body = await readJsonObject(request).catch(() => ({}))
    const expiresInSeconds = optionalStringField(body, 'expires_in_seconds')
      ? positiveIntegerField(body, 'expires_in_seconds')
      : undefined
    const { invite, rawToken } = createInviteToken({
      accountId: account.id,
      createdBy: 'admin',
      expiresInSeconds,
      now,
    })
    await store.createInvite(invite)
    await recordAuditAdminAction(store, {
      action: 'admin.invite.create',
      targetType: 'account',
      targetId: account.id,
      body,
      statusCode: 201,
      now,
      extra: { invite_id: invite.id },
    })
    return json(
      {
        id: invite.id,
        account_id: invite.accountId,
        invite_token: rawToken,
        invite_url: `${options.baseUrl ?? new URL(request.url).origin}/accept?token=${rawToken}&autocreate_key=1&tab=keys`,
        expires_at: invite.expiresAt,
        status: invite.status,
        created_at: invite.createdAt,
      },
      201
    )
  }

  const revokeAdminKeyMatch = /^\/admin\/api-keys\/([^/]+)\/revoke$/.exec(url.pathname)
  if (revokeAdminKeyMatch && request.method === 'POST') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const revoked = await store.revokeApiKey(revokeAdminKeyMatch[1], now)
    if (!revoked) throw new GatewayError('api_key_not_found', 404)
    await recordAuditAdminAction(store, {
      action: 'admin.api_key.revoke',
      targetType: 'api_key',
      targetId: revoked.id,
      statusCode: 200,
      now,
      extra: { account_id: revoked.accountId },
    })
    return json({
      id: revoked.id,
      account_id: revoked.accountId,
      status: revoked.status,
      revoked_at: revoked.revokedAt,
    })
  }

  const createApiKeyMatch = /^\/admin\/accounts\/([^/]+)\/api-keys$/.exec(url.pathname)
  if (createApiKeyMatch && request.method === 'POST') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    if (!pepper) throw new GatewayError('server_pepper_not_configured', 500)
    const account = await store.getAccount(createApiKeyMatch[1])
    if (!account) throw new GatewayError('account_not_found', 404)
    const body = await readJsonObject(request)
    const environment = optionalStringField(body, 'environment') === 'test' ? 'test' : 'live'
    const created = createApiKey({ environment })
    const apiKey = registerApiKey({
      id: optionalStringField(body, 'id') ?? `key_${crypto.randomUUID()}`,
      accountId: account.id,
      rawKey: created.rawKey,
      pepper,
      now,
      name: optionalStringField(body, 'name'),
    })
    await store.createApiKeyRecord(apiKey)
    await recordAuditAdminAction(store, {
      action: 'admin.api_key.create',
      targetType: 'api_key',
      targetId: apiKey.id,
      body,
      statusCode: 201,
      now,
      extra: { account_id: apiKey.accountId, prefix: apiKey.keyPrefix, last4: apiKey.keyLast4 },
    })
    return json(
      {
        id: apiKey.id,
        account_id: apiKey.accountId,
        name: apiKey.name,
        raw_key: created.rawKey,
        prefix: apiKey.keyPrefix,
        last4: apiKey.keyLast4,
        scope: apiKey.scope,
        status: apiKey.status,
        created_at: apiKey.createdAt,
      },
      201
    )
  }

  if (url.pathname === '/admin/provider-tokens' && request.method === 'POST') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const body = await readJsonObject(request)
    const id = optionalStringField(body, 'id') ?? `tok_${crypto.randomUUID()}`
    const provider = requireString(body, 'provider')
    const label = requireString(body, 'label')
    const adapter = optionalStringField(body, 'adapter') ?? provider
    const baseUrl = optionalStringField(body, 'base_url') ?? null
    const plaintext = requireString(body, 'plaintext')
    const models = stringArrayField(body, 'models')
    const keyVersion = optionalStringField(body, 'key_version') ?? 'v1'
    const token = await encryptProviderToken({
      id,
      provider,
      label,
      adapter,
      baseUrl,
      plaintext,
      masterKeys: getMasterKeys(options, env),
      keyVersion,
      now,
    })
    const channel = await store.upsertProviderToken({
      token,
      models,
      priority: positiveIntegerField(body, 'priority', 1),
      weight: positiveIntegerField(body, 'weight', 1),
      now,
    })
    await recordAuditAdminAction(store, {
      action: 'admin.provider_token.upsert',
      targetType: 'provider_token',
      targetId: channel.id,
      body,
      statusCode: 201,
      now,
      extra: { provider: channel.provider, adapter: channel.adapter, key_version: token.keyVersion },
    })
    return json(
      {
        id: channel.id,
        label: channel.label,
        provider: channel.provider,
        adapter: channel.adapter,
        models: channel.models,
        status: channel.status,
        key_version: token.keyVersion,
        updated_at: token.updatedAt,
      },
      201
    )
  }

  if (url.pathname === '/admin/price-book' && request.method === 'POST') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const body = await readJsonObject(request)
    const row: PriceBookRow = {
      id: optionalStringField(body, 'id') ?? `price_${crypto.randomUUID()}`,
      version: positiveIntegerField(body, 'version', 1),
      provider: requireString(body, 'provider'),
      model: requireString(body, 'model'),
      sellInputMicroUsdPer1MTokens: positiveIntegerField(body, 'sell_input_micro_usd_per_1m_tokens'),
      sellOutputMicroUsdPer1MTokens: positiveIntegerField(body, 'sell_output_micro_usd_per_1m_tokens'),
      upstreamInputMicroUsdPer1MTokens: positiveIntegerField(body, 'upstream_input_micro_usd_per_1m_tokens'),
      upstreamOutputMicroUsdPer1MTokens: positiveIntegerField(body, 'upstream_output_micro_usd_per_1m_tokens'),
      validFrom: optionalStringField(body, 'valid_from') ?? now,
      validTo: optionalStringField(body, 'valid_to') ?? null,
      enabled: booleanField(body, 'enabled', true),
    }
    const saved = await store.upsertPriceBook({ row, now })
    await recordAuditAdminAction(store, {
      action: 'admin.price_book.upsert',
      targetType: 'price_book',
      targetId: saved.id,
      body,
      statusCode: 201,
      now,
      extra: { provider: saved.provider, model: saved.model, version: saved.version },
    })
    return json(
      {
        id: saved.id,
        version: saved.version,
        provider: saved.provider,
        model: saved.model,
        sell_input_micro_usd_per_1m_tokens: saved.sellInputMicroUsdPer1MTokens,
        sell_output_micro_usd_per_1m_tokens: saved.sellOutputMicroUsdPer1MTokens,
        upstream_input_micro_usd_per_1m_tokens: saved.upstreamInputMicroUsdPer1MTokens,
        upstream_output_micro_usd_per_1m_tokens: saved.upstreamOutputMicroUsdPer1MTokens,
        valid_from: saved.validFrom,
        valid_to: saved.validTo,
        enabled: saved.enabled,
      },
      201
    )
  }

  if (url.pathname === '/admin/routing-rules' && request.method === 'POST') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const body = await readJsonObject(request)
    const rule: RoutingRule = {
      id: optionalStringField(body, 'id') ?? `route_${crypto.randomUUID()}`,
      accountGroup: optionalStringField(body, 'account_group') ?? 'default',
      requestedProvider: optionalStringField(body, 'requested_provider'),
      requestedModel: requireString(body, 'requested_model'),
      providerTokenId: requireString(body, 'provider_token_id'),
      actualProviderModel: optionalStringField(body, 'actual_provider_model') ?? requireString(body, 'requested_model'),
      priority: integerField(body, 'priority', 0),
      weight: positiveIntegerField(body, 'weight', 1),
      status: optionalStringField(body, 'status') === 'disabled' ? 'disabled' : 'active',
    }
    const saved = await store.upsertRoutingRule({ rule, now })
    await recordAuditAdminAction(store, {
      action: 'admin.routing_rule.upsert',
      targetType: 'routing_rule',
      targetId: saved.id,
      body,
      statusCode: 201,
      now,
      extra: {
        account_group: saved.accountGroup,
        requested_model: saved.requestedModel,
        provider_token_id: saved.providerTokenId,
      },
    })
    return json(
      {
        id: saved.id,
        account_group: saved.accountGroup,
        requested_provider: saved.requestedProvider,
        requested_model: saved.requestedModel,
        provider_token_id: saved.providerTokenId,
        actual_provider_model: saved.actualProviderModel,
        priority: saved.priority,
        weight: saved.weight,
        status: saved.status,
      },
      201
    )
  }

  if (url.pathname === '/admin/provider-tokens' && request.method === 'GET') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const channels = await store.listProviderTokenSummaries()
    return json({
      data: channels.map((channel) => ({
        id: channel.id,
        label: channel.label,
        provider: channel.provider,
        adapter: channel.adapter,
        base_url: channel.baseUrl ?? null,
        models: channel.models,
        status: channel.status,
        priority: channel.priority,
        weight: channel.weight,
        latency_ms: channel.latencyMs,
        error_rate: channel.errorRate,
        exhausted_until: channel.exhaustedUntil,
      })),
    })
  }

  if (url.pathname === '/admin/routing-rules' && request.method === 'GET') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const rules = await store.listRoutingRules()
    return json({
      data: rules.map((rule) => ({
        id: rule.id,
        account_group: rule.accountGroup,
        requested_provider: rule.requestedProvider ?? null,
        requested_model: rule.requestedModel,
        provider_token_id: rule.providerTokenId,
        actual_provider_model: rule.actualProviderModel,
        priority: rule.priority,
        weight: rule.weight,
        status: rule.status,
      })),
    })
  }

  if (url.pathname === '/admin/price-book' && request.method === 'GET') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const rows = await store.listPriceBook()
    return json({
      data: rows.map((row) => ({
        id: row.id,
        version: row.version,
        provider: row.provider,
        model: row.model,
        sell_input_micro_usd_per_1m_tokens: row.sellInputMicroUsdPer1MTokens,
        sell_output_micro_usd_per_1m_tokens: row.sellOutputMicroUsdPer1MTokens,
        upstream_input_micro_usd_per_1m_tokens: row.upstreamInputMicroUsdPer1MTokens,
        upstream_output_micro_usd_per_1m_tokens: row.upstreamOutputMicroUsdPer1MTokens,
        valid_from: row.validFrom,
        valid_to: row.validTo,
        enabled: row.enabled,
      })),
    })
  }

  if (url.pathname === '/admin/redpackets' && request.method === 'POST') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const body = await readJsonObject(request)
    const mycAmount = Number(body.amount_myc)
    if (!Number.isFinite(mycAmount) || mycAmount <= 0) throw new GatewayError('invalid_amount_myc', 400)
    const amountRaw = BigInt(Math.round(mycAmount * 1e6))
    const code = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8)
    const codeHash = await sha256Hex(code)
    const id = `rp_${crypto.randomUUID()}`
    await store.createRedpacket({ id, codeHash, amountRaw: amountRaw.toString(), label: optionalStringField(body, 'label'), status: 'unclaimed', createdAt: now })
    const origin = new URL(request.url).origin
    return json({ id, code, claim_url: `${origin}/?redpacket=${code}`, amount_myc: mycAmount, status: 'unclaimed' }, 201)
  }

  if (url.pathname === '/admin/redpackets' && request.method === 'GET') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const rows = await store.listRedpackets({ limit: 200 })
    return json({
      data: rows.map((r) => ({
        id: r.id,
        amount_myc: Number(r.amountRaw) / 1e6,
        label: r.label ?? null,
        status: r.status,
        claimed_by_account: r.claimedByAccount ?? null,
        claimed_to_address: r.claimedToAddress ?? null,
        claim_tx_hash: r.claimTxHash ?? null,
        created_at: r.createdAt,
        claimed_at: r.claimedAt ?? null,
      })),
    })
  }

  if (url.pathname === '/admin/topups' && request.method === 'GET') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const limitParam = url.searchParams.get('limit')
    const limit = limitParam ? Math.max(1, Math.min(500, Number(limitParam) || 100)) : 100
    const rows = await store.listOnchainTopups({ limit })
    return json({
      data: rows.map((r) => ({
        id: r.id,
        chain_id: r.chainId,
        tx_hash: r.txHash,
        log_index: r.logIndex,
        account_id: r.accountId,
        token_address: r.tokenAddress,
        from_address: r.fromAddress,
        amount_raw: r.amountRaw,
        burned_myc: Number(r.amountRaw) / 1e6,
        credited_micro_usd: r.creditedMicroUsd,
        created_at: r.createdAt,
      })),
    })
  }

  if (url.pathname === '/admin/usage' && request.method === 'GET') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const limitParam = url.searchParams.get('limit')
    const limit = limitParam ? Math.max(1, Math.min(500, Number(limitParam) || 100)) : 100
    const rows = await store.listRecentRequestLogs({ limit })
    return json({
      data: rows.map((row) => ({
        id: row.id,
        account_id: row.accountId,
        api_key_id: row.apiKeyId ?? null,
        provider_token_id: row.providerTokenId ?? null,
        routing_rule_id: row.routingRuleId ?? null,
        created_at: row.createdAt,
        provider: row.provider,
        model: row.model,
        endpoint: row.endpoint,
        status_code: row.statusCode,
        latency_ms: row.latencyMs,
        input_tokens: row.inputTokens ?? null,
        output_tokens: row.outputTokens ?? null,
        total_tokens: row.totalTokens ?? null,
        sell_cost_micro_usd: row.sellCostMicroUsd ?? null,
        upstream_cost_micro_usd: row.upstreamCostMicroUsd ?? null,
        error_code: row.errorCode ?? null,
      })),
    })
  }

  const channelStatusMatch = /^\/admin\/provider-tokens\/([^/]+)\/status$/.exec(url.pathname)
  if (channelStatusMatch && request.method === 'POST') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const body = await readJsonObject(request)
    const status = requireString(body, 'status')
    if (status !== 'active' && status !== 'disabled') {
      throw new GatewayError('invalid_status', 400)
    }
    const id = channelStatusMatch[1]
    await store.setProviderTokenStatus({ id, status, now })
    await recordAuditAdminAction(store, {
      action: 'admin.provider_token.set_status',
      targetType: 'provider_token',
      targetId: id,
      body,
      statusCode: 200,
      now,
      extra: { status },
    })
    return json({ id, status })
  }

  if (url.pathname === '/admin/audit-log' && request.method === 'GET') {
    await requireAdmin(request, adminToken, adminIpAllowlist)
    const limitParam = url.searchParams.get('limit')
    const sinceParam = url.searchParams.get('since')
    const actorParam = url.searchParams.get('actor')
    const limit = limitParam ? Math.max(1, Math.min(500, Number(limitParam) || 100)) : 100
    const records = await store.listAdminAudit({
      limit,
      since: sinceParam ?? undefined,
      actorFilter: actorParam ?? undefined,
    })
    return json({
      data: records.map((row) => ({
        id: row.id,
        actor: row.actor,
        action: row.action,
        target_type: row.targetType,
        target_id: row.targetId,
        metadata: row.metadata,
        created_at: row.createdAt,
      })),
    })
  }

  // API and dashboard JSON routes already returned above. Any path the Worker
  // didn't explicitly handle (/, /accept, /manage, /assets/*, ...) belongs to
  // the bundled SPA assets. With wrangler.toml's not_found_handling = "none"
  // Cloudflare will NOT auto-serve the static dir; the Worker has to forward.
  if (env?.ASSETS) {
    return env.ASSETS.fetch(request)
  }
  return json({ error: { code: 'not_found' } }, 404)
}

export function createGatewayApp(options: GatewayAppOptions = {}) {
  return {
    async fetch(request: Request, env?: GatewayEnv, ctx?: GatewayExecutionContext): Promise<Response> {
      try {
        return await handleRequest(request, options, env, ctx)
      } catch (error) {
        return toErrorResponse(error)
      }
    },
  }
}

export default {
  async fetch(request: Request, env?: GatewayEnv, ctx?: GatewayExecutionContext): Promise<Response> {
    try {
      return await createGatewayApp().fetch(request, env, ctx)
    } catch (error) {
      return toErrorResponse(error)
    }
  },
}

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
import { openAIAdapter } from './providers/openai.js'
import { createDashboardSession, createInviteToken, hashDashboardToken } from './routes/dashboard.js'
import { relayCompletion, relayCompletionStream } from './routes/relay.js'
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

async function authenticateDashboard(request: Request, store: GatewayStore, now: string): Promise<string> {
  const rawSession =
    parseCookie(request.headers.get('cookie'), 'mykey_dashboard_session') ??
    request.headers.get('x-dashboard-session')
  if (!rawSession) throw new GatewayError('dashboard_auth_required', 401)
  const session = await store.findDashboardSessionByHash(hashDashboardToken(rawSession), now)
  if (!session) throw new GatewayError('dashboard_auth_required', 401)
  return session.accountId
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

function requireActiveAccount(account: Awaited<ReturnType<GatewayStore['getAccount']>>) {
  if (!account) throw new GatewayError('account_not_found', 404)
  if (account.status !== 'active') throw new GatewayError('account_paused', 403)
  return account
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
  const accountRecord = requireActiveAccount(await store.getAccount(accountId))
  const body = await readJsonObject(request)
  const requestedModel =
    typeof body.model === 'string' && body.model.length > 0 ? body.model : accountRecord.defaultModel
  if (!requestedModel) throw new GatewayError('model_required', 400)

  const routing = resolveRoutingRule({
    accountGroup: accountRecord.accountGroup,
    requestedModel,
    requestedProvider: adapter.name,
    rules: await store.listRoutingRules(),
    providerTokens: providerTokenSummariesFromChannels(await store.listProviderTokenSummaries()),
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
    const cookie = [
      `mykey_dashboard_session=${session.sessionToken}`,
      'Path=/',
      'HttpOnly',
      'Secure',
      'SameSite=Strict',
      `Expires=${new Date(session.expiresAt).toUTCString()}`,
    ].join('; ')
    return new Response(null, {
      status: 302,
      headers: { location: '/', 'set-cookie': cookie },
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
        invite_url: `${options.baseUrl ?? new URL(request.url).origin}/accept?token=${rawToken}`,
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

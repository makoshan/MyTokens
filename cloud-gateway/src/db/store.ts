import type { AccountInvite } from '../routes/dashboard.js'
import type { ApiKeyRecord, PriceBookRow, RequestLog, RoutingRule } from '../types.js'
import type { ProviderTokenRecord } from '../vault/provider-tokens.js'

export interface GatewayAccountRecord {
  id: string
  displayName: string
  status: 'active' | 'paused' | 'disabled'
  accountGroup: string
  balanceMicroUsd: number
  reservedMicroUsd: number
  defaultProvider: string
  defaultModel?: string
  createdAt: string
  updatedAt: string
}

export interface DashboardSessionRecord {
  id: string
  accountId: string
  sessionHash: string
  status: 'active' | 'revoked'
  expiresAt: string
}

export interface ChannelRecord {
  id: string
  label: string
  provider: string
  adapter: string
  models: string[]
  status: 'active' | 'degraded' | 'exhausted' | 'paused' | 'disabled' | 'revoked'
  priority: number
  weight: number
  latencyMs: number
  errorRate: number
  exhaustedUntil: string | null
}

export interface ModelQualityRecord {
  model: string
  label: 'trusted' | 'mostly reliable' | 'degraded' | 'suspicious'
  latencyMs: number
  tokensPerSecond: number
  recentErrorRate: number
  channelStatus: 'active' | 'degraded' | 'exhausted' | 'paused'
}

export interface DashboardSnapshot {
  account: { id: string; displayName: string; status: GatewayAccountRecord['status'] }
  balanceMicroUsd: number
  todaySpendMicroUsd: number
  baseUrl: string
  apiKeys: Array<{
    id: string
    name: string
    prefix: string
    last4: string
    status: ApiKeyRecord['status']
    createdAt: string
    quotaMicroUsd?: number
    usedMicroUsd?: number
  }>
  channels: Array<{
    id: string
    label: string
    provider: string
    models: string[]
    status: ChannelRecord['status']
    priority: number
    weight: number
    latencyMs: number
    errorRate: number
  }>
  routingRules: Array<{
    id: string
    group: string
    requestedModel: string
    actualModel: string
    channelLabel: string
    status: RoutingRule['status']
  }>
  usage: Array<{
    id: string
    createdAt: string
    model: string
    endpoint: string
    inputTokens: number
    outputTokens: number
    costMicroUsd: number
    latencyMs: number
    status: 'ok' | 'error' | 'blocked'
  }>
  modelQuality: ModelQualityRecord[]
  creditRequests: Array<{
    id: string
    requestedMicroUsd: number
    message?: string
    status: 'pending' | 'approved' | 'rejected'
    createdAt?: string
  }>
}

export interface GatewayStore {
  findApiKeyByHash(hash: string): Promise<ApiKeyRecord | null>
  findApiKeyById(apiKeyId: string): Promise<ApiKeyRecord | null>
  revokeApiKey(apiKeyId: string, now: string): Promise<ApiKeyRecord | null>
  findDashboardSessionByHash(hash: string, now: string): Promise<DashboardSessionRecord | null>
  createDashboardSession(input: {
    id: string
    accountId: string
    sessionHash: string
    authMethod: 'passkey' | 'magic_link'
    createdAt: string
    expiresAt: string
  }): Promise<DashboardSessionRecord>
  createInvite(invite: AccountInvite): Promise<AccountInvite>
  findInviteByHash(hash: string): Promise<AccountInvite | null>
  markInviteAccepted(inviteId: string, now: string): Promise<void>
  getAccount(accountId: string): Promise<GatewayAccountRecord | null>
  listAccounts(): Promise<GatewayAccountRecord[]>
  createAccount(account: GatewayAccountRecord): Promise<GatewayAccountRecord>
  createApiKeyRecord(apiKey: ApiKeyRecord): Promise<ApiKeyRecord>
  getDashboardSnapshot(accountId: string): Promise<DashboardSnapshot>
  listModels(accountId: string): Promise<string[]>
  listUsage(accountId: string): Promise<RequestLog[]>
  listPriceBook(): Promise<PriceBookRow[]>
  listRoutingRules(): Promise<RoutingRule[]>
  listProviderTokenSummaries(): Promise<ChannelRecord[]>
  getProviderToken(providerTokenId: string): Promise<ProviderTokenRecord | null>
  upsertProviderToken(input: {
    token: ProviderTokenRecord
    models: string[]
    priority?: number
    weight?: number
    now: string
  }): Promise<ChannelRecord>
  upsertPriceBook(input: { row: PriceBookRow; now: string }): Promise<PriceBookRow>
  upsertRoutingRule(input: { rule: RoutingRule; now: string }): Promise<RoutingRule>
  persistRelayResult(input: {
    accountId: string
    balanceMicroUsd: number
    requestLog: RequestLog
    now: string
  }): Promise<void>
  updateProviderTokenRuntime(input: {
    providerTokenId: string
    statusCode: number
    latencyMs: number
    now: string
  }): Promise<void>
  manualCredit(accountId: string, amountMicroUsd: number, now: string): Promise<GatewayAccountRecord>
}

export class InMemoryGatewayStore implements GatewayStore {
  readonly accounts: GatewayAccountRecord[]
  readonly apiKeys: ApiKeyRecord[]
  readonly dashboardSessions: DashboardSessionRecord[]
  readonly invites: AccountInvite[]
  readonly channels: ChannelRecord[]
  readonly routingRules: RoutingRule[]
  readonly usage: RequestLog[]
  readonly modelQuality: ModelQualityRecord[]
  readonly providerTokens: ProviderTokenRecord[]
  readonly priceBook: PriceBookRow[]
  readonly baseUrl: string

  constructor(input: {
    baseUrl: string
    accounts: GatewayAccountRecord[]
    apiKeys?: ApiKeyRecord[]
    dashboardSessions?: DashboardSessionRecord[]
    invites?: AccountInvite[]
    channels?: ChannelRecord[]
    routingRules?: RoutingRule[]
    usage?: RequestLog[]
    modelQuality?: ModelQualityRecord[]
    providerTokens?: ProviderTokenRecord[]
    priceBook?: PriceBookRow[]
  }) {
    this.baseUrl = input.baseUrl
    this.accounts = input.accounts
    this.apiKeys = input.apiKeys ?? []
    this.dashboardSessions = input.dashboardSessions ?? []
    this.invites = input.invites ?? []
    this.channels = input.channels ?? []
    this.routingRules = input.routingRules ?? []
    this.usage = input.usage ?? []
    this.modelQuality = input.modelQuality ?? []
    this.providerTokens = input.providerTokens ?? []
    this.priceBook = input.priceBook ?? []
  }

  async findApiKeyByHash(hash: string): Promise<ApiKeyRecord | null> {
    return this.apiKeys.find((apiKey) => apiKey.keyHash === hash) ?? null
  }

  async findApiKeyById(apiKeyId: string): Promise<ApiKeyRecord | null> {
    return this.apiKeys.find((apiKey) => apiKey.id === apiKeyId) ?? null
  }

  async revokeApiKey(apiKeyId: string, now: string): Promise<ApiKeyRecord | null> {
    const apiKey = this.apiKeys.find((candidate) => candidate.id === apiKeyId)
    if (!apiKey) return null
    apiKey.status = 'revoked'
    apiKey.revokedAt = now
    return apiKey
  }

  async findDashboardSessionByHash(hash: string, now: string): Promise<DashboardSessionRecord | null> {
    const session = this.dashboardSessions.find((candidate) => candidate.sessionHash === hash) ?? null
    if (!session || session.status !== 'active') return null
    if (Date.parse(session.expiresAt) <= Date.parse(now)) return null
    return session
  }

  async createDashboardSession(input: {
    id: string
    accountId: string
    sessionHash: string
    authMethod: 'passkey' | 'magic_link'
    createdAt: string
    expiresAt: string
  }): Promise<DashboardSessionRecord> {
    const record: DashboardSessionRecord = {
      id: input.id,
      accountId: input.accountId,
      sessionHash: input.sessionHash,
      status: 'active',
      expiresAt: input.expiresAt,
    }
    this.dashboardSessions.push(record)
    return record
  }

  async createInvite(invite: AccountInvite): Promise<AccountInvite> {
    this.invites.push(invite)
    return invite
  }

  async findInviteByHash(hash: string): Promise<AccountInvite | null> {
    return this.invites.find((invite) => invite.inviteTokenHash === hash) ?? null
  }

  async markInviteAccepted(inviteId: string, now: string): Promise<void> {
    const invite = this.invites.find((candidate) => candidate.id === inviteId)
    if (!invite) return
    invite.status = 'accepted'
    invite.acceptedAt = now
  }

  async getAccount(accountId: string): Promise<GatewayAccountRecord | null> {
    return this.accounts.find((account) => account.id === accountId) ?? null
  }

  async listAccounts(): Promise<GatewayAccountRecord[]> {
    return this.accounts
  }

  async createAccount(account: GatewayAccountRecord): Promise<GatewayAccountRecord> {
    this.accounts.push(account)
    return account
  }

  async createApiKeyRecord(apiKey: ApiKeyRecord): Promise<ApiKeyRecord> {
    this.apiKeys.push(apiKey)
    return apiKey
  }

  async getDashboardSnapshot(accountId: string): Promise<DashboardSnapshot> {
    const account = await this.getAccount(accountId)
    if (!account) throw new Error('account_not_found')
    const accountUsage = this.usage.filter((row) => row.accountId === accountId)
    const todaySpendMicroUsd = accountUsage.reduce((sum, row) => sum + (row.sellCostMicroUsd ?? 0), 0)

    return {
      account: {
        id: account.id,
        displayName: account.displayName,
        status: account.status,
      },
      balanceMicroUsd: account.balanceMicroUsd,
      todaySpendMicroUsd,
      baseUrl: this.baseUrl,
      apiKeys: this.apiKeys
        .filter((apiKey) => apiKey.accountId === accountId)
        .map((apiKey) => ({
          id: apiKey.id,
          name: apiKey.name ?? apiKey.id,
          prefix: apiKey.keyPrefix,
          last4: apiKey.keyLast4,
          status: apiKey.status,
          createdAt: apiKey.createdAt,
        })),
      channels: this.channels.map((channel) => ({
        id: channel.id,
        label: channel.label,
        provider: channel.provider,
        models: channel.models,
        status: channel.status,
        priority: channel.priority,
        weight: channel.weight,
        latencyMs: channel.latencyMs,
        errorRate: channel.errorRate,
      })),
      routingRules: this.routingRules.map((rule) => ({
        id: rule.id,
        group: rule.accountGroup,
        requestedModel: rule.requestedModel,
        actualModel: rule.actualProviderModel,
        channelLabel:
          this.channels.find((channel) => channel.id === rule.providerTokenId)?.label ?? rule.providerTokenId,
        status: rule.status,
      })),
      usage: accountUsage.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        model: row.model,
        endpoint: row.endpoint,
        inputTokens: row.inputTokens ?? 0,
        outputTokens: row.outputTokens ?? 0,
        costMicroUsd: row.sellCostMicroUsd ?? 0,
        latencyMs: row.latencyMs,
        status: row.statusCode >= 200 && row.statusCode < 400 ? 'ok' : 'error',
      })),
      modelQuality: this.modelQuality,
      creditRequests: [],
    }
  }

  async listModels(_accountId: string): Promise<string[]> {
    return [...new Set(this.channels.flatMap((channel) => channel.models))].sort()
  }

  async listUsage(accountId: string): Promise<RequestLog[]> {
    return this.usage.filter((row) => row.accountId === accountId)
  }

  async listPriceBook(): Promise<PriceBookRow[]> {
    return this.priceBook
  }

  async listRoutingRules(): Promise<RoutingRule[]> {
    return this.routingRules
  }

  async listProviderTokenSummaries(): Promise<ChannelRecord[]> {
    return this.channels
  }

  async getProviderToken(providerTokenId: string): Promise<ProviderTokenRecord | null> {
    return this.providerTokens.find((token) => token.id === providerTokenId) ?? null
  }

  async upsertProviderToken(input: {
    token: ProviderTokenRecord
    models: string[]
    priority?: number
    weight?: number
    now: string
  }): Promise<ChannelRecord> {
    const existingTokenIndex = this.providerTokens.findIndex((token) => token.id === input.token.id)
    if (existingTokenIndex >= 0) {
      this.providerTokens[existingTokenIndex] = input.token
    } else {
      this.providerTokens.push(input.token)
    }

    const channel: ChannelRecord = {
      id: input.token.id,
      label: input.token.label,
      provider: input.token.provider,
      adapter: input.token.adapter,
      models: input.models,
      status: mapChannelStatus(input.token.status),
      priority: input.priority ?? 1,
      weight: input.weight ?? 1,
      latencyMs: input.token.lastResponseMs ?? 0,
      errorRate:
        (input.token.successCount ?? 0) + (input.token.failureCount ?? 0) > 0
          ? (input.token.failureCount ?? 0) / ((input.token.successCount ?? 0) + (input.token.failureCount ?? 0))
          : 0,
      exhaustedUntil: input.token.exhaustedUntil,
    }
    const existingChannelIndex = this.channels.findIndex((candidate) => candidate.id === channel.id)
    if (existingChannelIndex >= 0) {
      this.channels[existingChannelIndex] = channel
    } else {
      this.channels.push(channel)
    }
    return channel
  }

  async upsertPriceBook(input: { row: PriceBookRow; now: string }): Promise<PriceBookRow> {
    const existingIndex = this.priceBook.findIndex((row) => row.id === input.row.id)
    if (existingIndex >= 0) {
      this.priceBook[existingIndex] = input.row
    } else {
      this.priceBook.push(input.row)
    }
    return input.row
  }

  async upsertRoutingRule(input: { rule: RoutingRule; now: string }): Promise<RoutingRule> {
    const existingIndex = this.routingRules.findIndex((rule) => rule.id === input.rule.id)
    if (existingIndex >= 0) {
      this.routingRules[existingIndex] = input.rule
    } else {
      this.routingRules.push(input.rule)
    }
    return input.rule
  }

  async persistRelayResult(input: {
    accountId: string
    balanceMicroUsd: number
    requestLog: RequestLog
    now: string
  }): Promise<void> {
    const account = await this.getAccount(input.accountId)
    if (!account) throw new Error('account_not_found')
    account.balanceMicroUsd = input.balanceMicroUsd
    account.updatedAt = input.now
    this.usage.push(input.requestLog)
  }

  async updateProviderTokenRuntime(input: {
    providerTokenId: string
    statusCode: number
    latencyMs: number
    now: string
  }): Promise<void> {
    const channel = this.channels.find((candidate) => candidate.id === input.providerTokenId)
    if (!channel) return
    channel.latencyMs = input.latencyMs
    channel.errorRate = input.statusCode >= 200 && input.statusCode < 400 ? 0 : 1
    if (input.statusCode === 429) {
      channel.status = 'exhausted'
      channel.exhaustedUntil = new Date(Date.parse(input.now) + 5 * 60 * 1000).toISOString()
    }
    if (input.statusCode === 401 || input.statusCode === 403) {
      channel.status = 'disabled'
    }
  }

  async manualCredit(accountId: string, amountMicroUsd: number, now: string): Promise<GatewayAccountRecord> {
    const account = await this.getAccount(accountId)
    if (!account) throw new Error('account_not_found')
    account.balanceMicroUsd += amountMicroUsd
    account.updatedAt = now
    return account
  }
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<unknown>
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback
}

export class D1GatewayStore implements GatewayStore {
  constructor(
    private readonly db: D1Database,
    private readonly baseUrl: string
  ) {}

  async findApiKeyByHash(hash: string): Promise<ApiKeyRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM compute_api_keys WHERE key_hash = ? LIMIT 1')
      .bind(hash)
      .first<Record<string, unknown>>()
    if (!row) return null
    return {
      id: stringValue(row.id),
      accountId: stringValue(row.account_id),
      name: optionalString(row.name),
      keyPrefix: stringValue(row.key_prefix),
      keyLast4: stringValue(row.key_last4),
      keyHash: stringValue(row.key_hash),
      scope: stringValue(row.scope, 'compat_api'),
      derivationMode: stringValue(row.derivation_mode, 'random') === 'derived' ? 'derived' : 'random',
      status: stringValue(row.status, 'revoked') === 'active' ? 'active' : 'revoked',
      createdAt: stringValue(row.created_at),
      lastUsedAt: optionalString(row.last_used_at),
      expiresAt: optionalString(row.expires_at),
      revokedAt: optionalString(row.revoked_at),
    }
  }

  async findApiKeyById(apiKeyId: string): Promise<ApiKeyRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM compute_api_keys WHERE id = ? LIMIT 1')
      .bind(apiKeyId)
      .first<Record<string, unknown>>()
    if (!row) return null
    return {
      id: stringValue(row.id),
      accountId: stringValue(row.account_id),
      name: optionalString(row.name),
      keyPrefix: stringValue(row.key_prefix),
      keyLast4: stringValue(row.key_last4),
      keyHash: stringValue(row.key_hash),
      scope: stringValue(row.scope, 'compat_api'),
      derivationMode: stringValue(row.derivation_mode, 'random') === 'derived' ? 'derived' : 'random',
      status: stringValue(row.status, 'revoked') === 'active' ? 'active' : 'revoked',
      createdAt: stringValue(row.created_at),
      lastUsedAt: optionalString(row.last_used_at),
      expiresAt: optionalString(row.expires_at),
      revokedAt: optionalString(row.revoked_at),
    }
  }

  async revokeApiKey(apiKeyId: string, now: string): Promise<ApiKeyRecord | null> {
    await this.db
      .prepare('UPDATE compute_api_keys SET status = ?, revoked_at = ? WHERE id = ?')
      .bind('revoked', now, apiKeyId)
      .run()
    return this.findApiKeyById(apiKeyId)
  }

  async findDashboardSessionByHash(hash: string, now: string): Promise<DashboardSessionRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM compute_dashboard_sessions WHERE session_hash = ? AND status = ? AND expires_at > ? LIMIT 1'
      )
      .bind(hash, 'active', now)
      .first<Record<string, unknown>>()
    if (!row) return null
    return {
      id: stringValue(row.id),
      accountId: stringValue(row.account_id),
      sessionHash: stringValue(row.session_hash),
      status: 'active',
      expiresAt: stringValue(row.expires_at),
    }
  }

  async createDashboardSession(input: {
    id: string
    accountId: string
    sessionHash: string
    authMethod: 'passkey' | 'magic_link'
    createdAt: string
    expiresAt: string
  }): Promise<DashboardSessionRecord> {
    await this.db
      .prepare(
        'INSERT INTO compute_dashboard_sessions (id, account_id, session_hash, auth_method, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(input.id, input.accountId, input.sessionHash, input.authMethod, 'active', input.createdAt, input.expiresAt)
      .run()
    return {
      id: input.id,
      accountId: input.accountId,
      sessionHash: input.sessionHash,
      status: 'active',
      expiresAt: input.expiresAt,
    }
  }

  async createInvite(invite: AccountInvite): Promise<AccountInvite> {
    await this.db
      .prepare(
        'INSERT INTO compute_account_invites (id, account_id, invite_token_hash, status, expires_at, accepted_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        invite.id,
        invite.accountId,
        invite.inviteTokenHash,
        invite.status,
        invite.expiresAt,
        invite.acceptedAt ?? null,
        invite.createdAt,
        invite.createdBy
      )
      .run()
    return invite
  }

  async findInviteByHash(hash: string): Promise<AccountInvite | null> {
    const row = await this.db
      .prepare('SELECT * FROM compute_account_invites WHERE invite_token_hash = ? LIMIT 1')
      .bind(hash)
      .first<Record<string, unknown>>()
    if (!row) return null
    const status = stringValue(row.status)
    return {
      id: stringValue(row.id),
      accountId: stringValue(row.account_id),
      inviteTokenHash: stringValue(row.invite_token_hash),
      status: status === 'accepted' || status === 'revoked' ? status : 'active',
      expiresAt: stringValue(row.expires_at),
      createdAt: stringValue(row.created_at),
      createdBy: stringValue(row.created_by),
      acceptedAt: optionalString(row.accepted_at) ?? null,
    }
  }

  async markInviteAccepted(inviteId: string, now: string): Promise<void> {
    await this.db
      .prepare('UPDATE compute_account_invites SET status = ?, accepted_at = ? WHERE id = ?')
      .bind('accepted', now, inviteId)
      .run()
  }

  async getAccount(accountId: string): Promise<GatewayAccountRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM compute_accounts WHERE id = ? LIMIT 1')
      .bind(accountId)
      .first<Record<string, unknown>>()
    if (!row) return null
    const latestLedger = await this.db
      .prepare(
        'SELECT balance_after_micro_usd FROM compute_ledger_entries WHERE account_id = ? AND balance_after_micro_usd IS NOT NULL ORDER BY created_at DESC LIMIT 1'
      )
      .bind(accountId)
      .first<Record<string, unknown>>()

    return {
      id: stringValue(row.id),
      displayName: stringValue(row.display_name),
      status:
        stringValue(row.status) === 'active'
          ? 'active'
          : stringValue(row.status) === 'paused'
            ? 'paused'
            : 'disabled',
      accountGroup: stringValue(row.account_group, 'default'),
      balanceMicroUsd: numberValue(latestLedger?.balance_after_micro_usd),
      reservedMicroUsd: 0,
      defaultProvider: stringValue(row.default_provider),
      defaultModel: optionalString(row.default_model),
      createdAt: stringValue(row.created_at),
      updatedAt: stringValue(row.updated_at),
    }
  }

  async listAccounts(): Promise<GatewayAccountRecord[]> {
    const rows = await this.db.prepare('SELECT id FROM compute_accounts ORDER BY created_at DESC').all<Record<string, unknown>>()
    const accounts = await Promise.all(rows.results.map((row) => this.getAccount(stringValue(row.id))))
    return accounts.filter((account): account is GatewayAccountRecord => Boolean(account))
  }

  async createAccount(account: GatewayAccountRecord): Promise<GatewayAccountRecord> {
    await this.db
      .prepare(
        'INSERT INTO compute_accounts (id, display_name, status, account_group, default_provider, default_model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        account.id,
        account.displayName,
        account.status,
        account.accountGroup,
        account.defaultProvider,
        account.defaultModel ?? null,
        account.createdAt,
        account.updatedAt
      )
      .run()
    return account
  }

  async createApiKeyRecord(apiKey: ApiKeyRecord): Promise<ApiKeyRecord> {
    await this.db
      .prepare(
        'INSERT INTO compute_api_keys (id, account_id, name, key_prefix, key_last4, key_hash, scope, derivation_mode, derivation_fingerprint, derivation_index, ip_allowlist_json, model_allowlist_json, rpm_limit, status, created_at, last_used_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        apiKey.id,
        apiKey.accountId,
        apiKey.name ?? null,
        apiKey.keyPrefix,
        apiKey.keyLast4,
        apiKey.keyHash,
        apiKey.scope,
        apiKey.derivationMode,
        apiKey.derivationFingerprint ?? null,
        apiKey.derivationIndex ?? null,
        apiKey.ipAllowlistJson ?? null,
        apiKey.modelAllowlistJson ?? null,
        apiKey.rpmLimit ?? null,
        apiKey.status,
        apiKey.createdAt,
        apiKey.lastUsedAt ?? null,
        apiKey.expiresAt ?? null,
        apiKey.revokedAt ?? null
      )
      .run()
    return apiKey
  }

  async getDashboardSnapshot(accountId: string): Promise<DashboardSnapshot> {
    const memory = new InMemoryGatewayStore({
      baseUrl: this.baseUrl,
      accounts: [(await this.getAccount(accountId)) ?? missingAccount(accountId)],
      apiKeys: await this.listApiKeys(accountId),
      channels: await this.listChannels(),
      routingRules: await this.listRoutingRules(),
      usage: await this.listUsage(accountId),
      modelQuality: await this.listModelQuality(),
    })
    return memory.getDashboardSnapshot(accountId)
  }

  async listModels(_accountId: string): Promise<string[]> {
    const channels = await this.listChannels()
    return [...new Set(channels.flatMap((channel) => channel.models))].sort()
  }

  async listUsage(accountId: string): Promise<RequestLog[]> {
    const rows = await this.db
      .prepare('SELECT * FROM compute_request_logs WHERE account_id = ? ORDER BY created_at DESC LIMIT 100')
      .bind(accountId)
      .all<Record<string, unknown>>()
    return rows.results.map((row) => ({
      id: stringValue(row.id),
      accountId: stringValue(row.account_id),
      apiKeyId: optionalString(row.api_key_id),
      providerTokenId: optionalString(row.provider_token_id),
      routingRuleId: optionalString(row.routing_rule_id),
      createdAt: stringValue(row.created_at),
      provider: stringValue(row.provider),
      model: stringValue(row.model),
      endpoint: stringValue(row.endpoint),
      statusCode: numberValue(row.status_code),
      latencyMs: numberValue(row.latency_ms),
      inputTokens: numberValue(row.input_tokens),
      outputTokens: numberValue(row.output_tokens),
      totalTokens: numberValue(row.total_tokens),
      sellCostMicroUsd: numberValue(row.sell_cost_micro_usd),
      upstreamCostMicroUsd: numberValue(row.upstream_cost_micro_usd),
    }))
  }

  async manualCredit(accountId: string, amountMicroUsd: number, now: string): Promise<GatewayAccountRecord> {
    const account = await this.getAccount(accountId)
    if (!account) throw new Error('account_not_found')
    const balanceAfter = account.balanceMicroUsd + amountMicroUsd
    await this.db
      .prepare(
        'INSERT INTO compute_ledger_entries (id, account_id, type, amount_micro_usd, balance_after_micro_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .bind(`ledger_${crypto.randomUUID()}`, accountId, 'credit', amountMicroUsd, balanceAfter, now)
      .run()
    return { ...account, balanceMicroUsd: balanceAfter, updatedAt: now }
  }

  private async listApiKeys(accountId: string): Promise<ApiKeyRecord[]> {
    const rows = await this.db
      .prepare('SELECT * FROM compute_api_keys WHERE account_id = ? ORDER BY created_at DESC')
      .bind(accountId)
      .all<Record<string, unknown>>()
    return rows.results.map((row) => ({
      id: stringValue(row.id),
      accountId,
      name: optionalString(row.name),
      keyPrefix: stringValue(row.key_prefix),
      keyLast4: stringValue(row.key_last4),
      keyHash: stringValue(row.key_hash),
      scope: stringValue(row.scope, 'compat_api'),
      derivationMode: 'random',
      status: stringValue(row.status) === 'active' ? 'active' : 'revoked',
      createdAt: stringValue(row.created_at),
    }))
  }

  async listPriceBook(): Promise<PriceBookRow[]> {
    const rows = await this.db.prepare('SELECT * FROM compute_price_book WHERE enabled = 1').all<Record<string, unknown>>()
    return rows.results.map((row) => ({
      id: stringValue(row.id),
      version: numberValue(row.version),
      provider: stringValue(row.provider),
      model: stringValue(row.model),
      upstreamInputMicroUsdPer1MTokens: numberValue(row.upstream_input_micro_usd_per_1m_tokens),
      upstreamOutputMicroUsdPer1MTokens: numberValue(row.upstream_output_micro_usd_per_1m_tokens),
      sellInputMicroUsdPer1MTokens: numberValue(row.sell_input_micro_usd_per_1m_tokens),
      sellOutputMicroUsdPer1MTokens: numberValue(row.sell_output_micro_usd_per_1m_tokens),
      validFrom: stringValue(row.valid_from),
      validTo: optionalString(row.valid_to) ?? null,
      enabled: numberValue(row.enabled) === 1,
    }))
  }

  async listProviderTokenSummaries(): Promise<ChannelRecord[]> {
    return this.listChannels()
  }

  async listRoutingRules(): Promise<RoutingRule[]> {
    return this.queryRoutingRules()
  }

  async getProviderToken(providerTokenId: string): Promise<ProviderTokenRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM compute_provider_tokens WHERE id = ? LIMIT 1')
      .bind(providerTokenId)
      .first<Record<string, unknown>>()
    if (!row) return null
    return {
      id: stringValue(row.id),
      provider: stringValue(row.provider),
      label: stringValue(row.label),
      adapter: stringValue(row.adapter),
      status: mapProviderTokenStatus(stringValue(row.status)),
      exhaustedUntil: optionalString(row.exhausted_until) ?? null,
      successCount: numberValue(row.success_count),
      failureCount: numberValue(row.failure_count),
      lastError: optionalString(row.last_error),
      lastResponseMs: numberValue(row.last_response_ms),
      ciphertext: stringValue(row.ciphertext),
      nonce: stringValue(row.nonce),
      keyVersion: stringValue(row.key_version),
      createdAt: stringValue(row.created_at),
      updatedAt: stringValue(row.updated_at),
    }
  }

  async upsertProviderToken(input: {
    token: ProviderTokenRecord
    models: string[]
    priority?: number
    weight?: number
    now: string
  }): Promise<ChannelRecord> {
    await this.db
      .prepare(
        'INSERT OR REPLACE INTO compute_provider_tokens (id, provider, label, adapter, models_json, status, scope_json, secret_ref, ciphertext, nonce, key_version, derivation_fingerprint, success_count, failure_count, exhausted_until, last_error, last_response_ms, last_used_at, rotated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        input.token.id,
        input.token.provider,
        input.token.label,
        input.token.adapter,
        JSON.stringify(input.models),
        input.token.status,
        input.token.scopeJson ?? null,
        input.token.secretRef ?? null,
        input.token.ciphertext,
        input.token.nonce,
        input.token.keyVersion,
        input.token.derivationFingerprint ?? null,
        input.token.successCount ?? 0,
        input.token.failureCount ?? 0,
        input.token.exhaustedUntil,
        input.token.lastError ?? null,
        input.token.lastResponseMs ?? null,
        input.token.lastUsedAt ?? null,
        input.token.rotatedAt ?? null,
        input.token.createdAt,
        input.now
      )
      .run()

    return {
      id: input.token.id,
      label: input.token.label,
      provider: input.token.provider,
      adapter: input.token.adapter,
      models: input.models,
      status: mapChannelStatus(input.token.status),
      priority: input.priority ?? 1,
      weight: input.weight ?? 1,
      latencyMs: input.token.lastResponseMs ?? 0,
      errorRate: 0,
      exhaustedUntil: input.token.exhaustedUntil,
    }
  }

  async upsertPriceBook(input: { row: PriceBookRow; now: string }): Promise<PriceBookRow> {
    await this.db
      .prepare(
        'INSERT OR REPLACE INTO compute_price_book (id, version, provider, model, upstream_input_micro_usd_per_1m_tokens, upstream_output_micro_usd_per_1m_tokens, sell_input_micro_usd_per_1m_tokens, sell_output_micro_usd_per_1m_tokens, valid_from, valid_to, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        input.row.id,
        input.row.version,
        input.row.provider,
        input.row.model,
        input.row.upstreamInputMicroUsdPer1MTokens,
        input.row.upstreamOutputMicroUsdPer1MTokens,
        input.row.sellInputMicroUsdPer1MTokens,
        input.row.sellOutputMicroUsdPer1MTokens,
        input.row.validFrom,
        input.row.validTo,
        input.row.enabled ? 1 : 0,
        input.now,
        input.now
      )
      .run()
    return input.row
  }

  async upsertRoutingRule(input: { rule: RoutingRule; now: string }): Promise<RoutingRule> {
    await this.db
      .prepare(
        'INSERT OR REPLACE INTO compute_routing_rules (id, account_group, requested_provider, requested_model, provider_token_id, actual_provider_model, priority, weight, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        input.rule.id,
        input.rule.accountGroup,
        input.rule.requestedProvider ?? null,
        input.rule.requestedModel,
        input.rule.providerTokenId,
        input.rule.actualProviderModel,
        input.rule.priority,
        input.rule.weight,
        input.rule.status,
        input.now,
        input.now
      )
      .run()
    return input.rule
  }

  async persistRelayResult(input: {
    accountId: string
    balanceMicroUsd: number
    requestLog: RequestLog
    now: string
  }): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO compute_request_logs (id, account_id, api_key_id, provider_token_id, routing_rule_id, created_at, provider, model, endpoint, status_code, latency_ms, input_tokens, output_tokens, total_tokens, sell_cost_micro_usd, upstream_cost_micro_usd, error_code, request_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        input.requestLog.id,
        input.accountId,
        input.requestLog.apiKeyId ?? null,
        input.requestLog.providerTokenId ?? null,
        input.requestLog.routingRuleId ?? null,
        input.requestLog.createdAt,
        input.requestLog.provider,
        input.requestLog.model,
        input.requestLog.endpoint,
        input.requestLog.statusCode,
        input.requestLog.latencyMs,
        input.requestLog.inputTokens ?? null,
        input.requestLog.outputTokens ?? null,
        input.requestLog.totalTokens ?? null,
        input.requestLog.sellCostMicroUsd ?? null,
        input.requestLog.upstreamCostMicroUsd ?? null,
        input.requestLog.errorCode ?? null,
        input.requestLog.requestHash ?? null
      )
      .run()
    await this.db
      .prepare(
        'INSERT INTO compute_ledger_entries (id, account_id, type, amount_micro_usd, balance_after_micro_usd, provider, model, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        `ledger_${crypto.randomUUID()}`,
        input.accountId,
        'settle',
        -(input.requestLog.sellCostMicroUsd ?? 0),
        input.balanceMicroUsd,
        input.requestLog.provider,
        input.requestLog.model,
        input.requestLog.id,
        input.now
      )
      .run()
  }

  async updateProviderTokenRuntime(input: {
    providerTokenId: string
    statusCode: number
    latencyMs: number
    now: string
  }): Promise<void> {
    const failureDelta = input.statusCode >= 200 && input.statusCode < 400 ? 0 : 1
    const successDelta = failureDelta === 0 ? 1 : 0
    const exhaustedUntil = input.statusCode === 429 ? new Date(Date.parse(input.now) + 5 * 60 * 1000).toISOString() : null
    const status = input.statusCode === 401 || input.statusCode === 403 ? 'disabled' : null
    await this.db
      .prepare(
        'UPDATE compute_provider_tokens SET success_count = success_count + ?, failure_count = failure_count + ?, last_response_ms = ?, last_error = ?, exhausted_until = COALESCE(?, exhausted_until), status = COALESCE(?, status), updated_at = ? WHERE id = ?'
      )
      .bind(
        successDelta,
        failureDelta,
        input.latencyMs,
        failureDelta ? `http_${input.statusCode}` : null,
        exhaustedUntil,
        status,
        input.now,
        input.providerTokenId
      )
      .run()
  }

  private async listChannels(): Promise<ChannelRecord[]> {
    const rows = await this.db
      .prepare('SELECT * FROM compute_provider_tokens ORDER BY provider, label')
      .all<Record<string, unknown>>()
    return rows.results.map((row) => ({
      id: stringValue(row.id),
      label: stringValue(row.label),
      provider: stringValue(row.provider),
      adapter: stringValue(row.adapter),
      models: parseJsonArray(row.models_json),
      status: mapChannelStatus(stringValue(row.status)),
      priority: 1,
      weight: 1,
      latencyMs: numberValue(row.last_response_ms),
      errorRate: 0,
      exhaustedUntil: optionalString(row.exhausted_until) ?? null,
    }))
  }

  private async queryRoutingRules(): Promise<RoutingRule[]> {
    const rows = await this.db
      .prepare('SELECT * FROM compute_routing_rules ORDER BY account_group, requested_model, priority')
      .all<Record<string, unknown>>()
    return rows.results.map((row) => ({
      id: stringValue(row.id),
      accountGroup: stringValue(row.account_group, 'default'),
      requestedModel: stringValue(row.requested_model),
      requestedProvider: optionalString(row.requested_provider),
      providerTokenId: stringValue(row.provider_token_id),
      actualProviderModel: stringValue(row.actual_provider_model, stringValue(row.requested_model)),
      priority: numberValue(row.priority),
      weight: numberValue(row.weight),
      status: stringValue(row.status) === 'active' ? 'active' : 'disabled',
    }))
  }

  private async listModelQuality(): Promise<ModelQualityRecord[]> {
    const channels = await this.listChannels()
    return channels.flatMap((channel) =>
      channel.models.map((model) => ({
        model,
        label: channel.status === 'active' ? 'trusted' : 'degraded',
        latencyMs: channel.latencyMs,
        tokensPerSecond: 0,
        recentErrorRate: channel.errorRate,
        channelStatus: channel.status === 'active' ? 'active' : 'degraded',
      }))
    )
  }
}

function missingAccount(accountId: string): GatewayAccountRecord {
  throw new Error(`account_not_found:${accountId}`)
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function mapChannelStatus(status: string): ChannelRecord['status'] {
  if (status === 'active' || status === 'degraded' || status === 'exhausted' || status === 'paused') {
    return status
  }
  if (status === 'disabled' || status === 'revoked') return status
  return 'disabled'
}

function mapProviderTokenStatus(status: string): ProviderTokenRecord['status'] {
  if (status === 'active' || status === 'revoked') return status
  return 'disabled'
}

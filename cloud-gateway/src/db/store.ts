import type { AccountInvite } from '../routes/dashboard.js'
import type {
  AdminAuditRecord,
  ApiKeyRecord,
  CreditRequestRecord,
  CreditRequestStatus,
  PriceBookRow,
  RequestLog,
  RoutingRule,
} from '../types.js'
import type { ProviderTokenRecord } from '../vault/provider-tokens.js'

export interface GatewayAccountRecord {
  id: string
  displayName: string
  status: 'active' | 'paused' | 'disabled'
  accountGroup: string
  // Multi-tenant owner. Undefined = legacy/single-tenant (unscoped). Set =
  // the operator who owns this friend account; relay scopes routing to it.
  operatorId?: string | null
  balanceMicroUsd: number
  reservedMicroUsd: number
  defaultProvider: string
  defaultModel?: string
  modelAllowlist?: string[] | null
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

export interface OperatorRecord {
  id: string
  pubkeyAddress: string
  displayName?: string | null
  status: 'active' | 'disabled'
  createdAt: string
}

export interface OperatorSessionRecord {
  id: string
  operatorId: string
  sessionHash: string
  expiresAt: string
}

export interface TreasuryCreditRecord {
  id: string
  operatorId: string
  accountId?: string | null
  amountMicroUsd: number
  stablecoinTxHash: string
  createdAt: string
}

export interface TreasuryWithdrawalRecord {
  id: string
  operatorId: string
  amountMicroUsd: number
  toAddress: string
  txHash: string
  createdAt: string
}

export interface StablecoinFaucetClaimRecord {
  id: string
  accountId: string
  toAddress: string
  amountRaw: string
  txHash?: string | null
  createdAt: string
}

/** Per-operator income view: real USDC collected vs. accounting compute margin. */
export interface OperatorRevenue {
  // Real money: USDC paid into the shared relayer by this operator's friends,
  // minus what this operator has already withdrawn. This is the withdrawable cap.
  treasuryCreditedMicroUsd: number
  treasuryWithdrawnMicroUsd: number
  // Accounting: resold-compute gross margin = Σ(sell − upstream) over this
  // operator's request logs. Denominated in account credit, not withdrawable.
  sellMicroUsd: number
  upstreamMicroUsd: number
  marginMicroUsd: number
  calls: number
  totalTokens: number
}

export interface ChannelRecord {
  id: string
  label: string
  provider: string
  adapter: string
  // Multi-tenant owner. Undefined = legacy/unscoped (all operators' relays may use it).
  operatorId?: string | null
  baseUrl?: string | null
  models: string[]
  status: 'active' | 'degraded' | 'exhausted' | 'paused' | 'disabled' | 'revoked'
  priority: number
  weight: number
  latencyMs: number
  errorRate: number
  exhaustedUntil: string | null
}

function ownerMatchesAccount(account: GatewayAccountRecord, ownerId?: string | null): boolean {
  if (!account.operatorId) return true
  return ownerId === account.operatorId
}

function ruleVisibleToAccount(account: GatewayAccountRecord, rule: RoutingRule): boolean {
  return (
    ownerMatchesAccount(account, rule.operatorId) &&
    (rule.accountGroup === account.accountGroup || rule.accountGroup === 'default')
  )
}

function channelIsRoutableForRules(channel: ChannelRecord, visibleRules: RoutingRule[]): boolean {
  return visibleRules.some((rule) => rule.providerTokenId === channel.id)
}

function modelAllowedForAccount(account: GatewayAccountRecord, model: string): boolean {
  const allowlist = account.modelAllowlist
  return !allowlist || allowlist.length === 0 || allowlist.includes(model)
}

export interface OnchainTopupRecord {
  id: string
  chainId: number
  txHash: string
  logIndex: number
  accountId: string
  tokenAddress: string
  fromAddress: string
  toAddress: string
  amountRaw: string
  creditedMicroUsd: number
  createdAt: string
}

export interface RedpacketRecord {
  id: string
  codeHash: string
  amountRaw: string
  label?: string
  status: 'unclaimed' | 'claimed'
  claimedByAccount?: string
  claimedToAddress?: string
  claimTxHash?: string
  createdAt: string
  claimedAt?: string
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
  findOperatorByAddress(address: string): Promise<OperatorRecord | null>
  createOperator(input: {
    id: string
    pubkeyAddress: string
    displayName?: string | null
    createdAt: string
  }): Promise<OperatorRecord>
  findOperatorSessionByHash(hash: string, now: string): Promise<OperatorSessionRecord | null>
  createOperatorSession(input: {
    id: string
    operatorId: string
    sessionHash: string
    expiresAt: string
  }): Promise<OperatorSessionRecord>
  createInvite(invite: AccountInvite): Promise<AccountInvite>
  listInvites(input?: { operatorId?: string; accountId?: string }): Promise<AccountInvite[]>
  findInviteByHash(hash: string): Promise<AccountInvite | null>
  markInviteAccepted(inviteId: string, now: string): Promise<void>
  revokeInvite(inviteId: string, now: string): Promise<AccountInvite | null>
  deleteInvite(inviteId: string): Promise<AccountInvite | null>
  getAccount(accountId: string): Promise<GatewayAccountRecord | null>
  listAccounts(operatorId?: string): Promise<GatewayAccountRecord[]>
  createAccount(account: GatewayAccountRecord): Promise<GatewayAccountRecord>
  updateAccount(input: {
    accountId: string
    displayName?: string
    defaultModel?: string
    modelAllowlist?: string[] | null
    status?: GatewayAccountRecord['status']
    now: string
  }): Promise<GatewayAccountRecord | null>
  createApiKeyRecord(apiKey: ApiKeyRecord): Promise<ApiKeyRecord>
  getDashboardSnapshot(accountId: string): Promise<DashboardSnapshot>
  listModels(accountId: string): Promise<string[]>
  listUsage(accountId: string): Promise<RequestLog[]>
  listRecentRequestLogs(input?: { limit?: number }): Promise<RequestLog[]>
  setProviderTokenStatus(input: { id: string; status: 'active' | 'disabled'; now: string }): Promise<void>
  isOnchainTopupConsumed(input: { chainId: number; txHash: string; logIndex: number }): Promise<boolean>
  recordOnchainTopup(record: OnchainTopupRecord): Promise<void>
  listOnchainTopups(input?: { limit?: number }): Promise<OnchainTopupRecord[]>
  createRedpacket(record: RedpacketRecord): Promise<void>
  getRedpacketByCodeHash(codeHash: string): Promise<RedpacketRecord | null>
  /** Atomically transition unclaimed→claimed; returns true only for the caller
   *  that wins. Guards against two concurrent claims of the same code both
   *  triggering a relayer transfer. The tx hash is filled in afterwards. */
  claimRedpacket(input: { id: string; account: string; toAddress: string; now: string }): Promise<boolean>
  /** Backfill the on-chain tx hash once the relayer transfer has confirmed. */
  setRedpacketClaimTx(input: { id: string; txHash: string }): Promise<void>
  /** Release a won claim back to unclaimed when the relayer transfer fails. */
  revertRedpacketClaim(input: { id: string }): Promise<void>
  listRedpackets(input?: { limit?: number }): Promise<RedpacketRecord[]>
  listPriceBook(): Promise<PriceBookRow[]>
  // operatorId scopes to one tenant; omitted = all (legacy/admin/platform view).
  listRoutingRules(operatorId?: string): Promise<RoutingRule[]>
  listProviderTokenSummaries(operatorId?: string): Promise<ChannelRecord[]>
  getProviderToken(providerTokenId: string): Promise<ProviderTokenRecord | null>
  upsertProviderToken(input: {
    token: ProviderTokenRecord
    models: string[]
    priority?: number
    weight?: number
    operatorId?: string | null
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
  createCreditRequest(record: CreditRequestRecord): Promise<CreditRequestRecord>
  listCreditRequests(input: {
    accountId?: string
    statusFilter?: CreditRequestStatus
    limit?: number
  }): Promise<CreditRequestRecord[]>
  getCreditRequest(id: string): Promise<CreditRequestRecord | null>
  resolveCreditRequest(input: {
    id: string
    decision: 'approve' | 'reject'
    resolvedBy: string
    now: string
  }): Promise<{ record: CreditRequestRecord; ok: true } | { record: CreditRequestRecord; ok: false; reason: 'already_resolved' }>
  recordAdminAudit(record: AdminAuditRecord): Promise<AdminAuditRecord>
  listAdminAudit(input: { limit?: number; since?: string; actorFilter?: string }): Promise<AdminAuditRecord[]>
  // Treasury ledger (per-operator income). Credit is idempotent on the on-chain
  // payment tx so a replayed buy-myc can never double-count.
  recordTreasuryCredit(record: TreasuryCreditRecord): Promise<void>
  recordTreasuryWithdrawal(record: TreasuryWithdrawalRecord): Promise<void>
  getOperatorRevenue(operatorId: string): Promise<OperatorRevenue>
  claimStablecoinFaucet(record: StablecoinFaucetClaimRecord): Promise<boolean>
  setStablecoinFaucetTx(input: { id: string; txHash: string }): Promise<void>
  revertStablecoinFaucetClaim(input: { id: string }): Promise<void>
}

export class InMemoryGatewayStore implements GatewayStore {
  readonly accounts: GatewayAccountRecord[]
  readonly apiKeys: ApiKeyRecord[]
  readonly dashboardSessions: DashboardSessionRecord[]
  readonly operators: OperatorRecord[] = []
  readonly operatorSessions: OperatorSessionRecord[] = []
  readonly invites: AccountInvite[]
  readonly channels: ChannelRecord[]
  readonly routingRules: RoutingRule[]
  readonly usage: RequestLog[]
  readonly modelQuality: ModelQualityRecord[]
  readonly providerTokens: ProviderTokenRecord[]
  readonly priceBook: PriceBookRow[]
  readonly creditRequests: CreditRequestRecord[]
  readonly onchainTopups: OnchainTopupRecord[] = []
  readonly redpackets: RedpacketRecord[] = []
  readonly treasuryCredits: TreasuryCreditRecord[] = []
  readonly treasuryWithdrawals: TreasuryWithdrawalRecord[] = []
  readonly stablecoinFaucetClaims: StablecoinFaucetClaimRecord[] = []
  readonly ledger: Array<{ id: string; accountId: string; type: string; amountMicroUsd: number; createdAt: string }>
  readonly auditLog: AdminAuditRecord[]
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
    creditRequests?: CreditRequestRecord[]
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
    this.creditRequests = input.creditRequests ?? []
    this.ledger = []
    this.auditLog = []
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

  async findOperatorByAddress(address: string): Promise<OperatorRecord | null> {
    const addr = address.trim().toLowerCase()
    return this.operators.find((op) => op.pubkeyAddress === addr) ?? null
  }

  async createOperator(input: {
    id: string
    pubkeyAddress: string
    displayName?: string | null
    createdAt: string
  }): Promise<OperatorRecord> {
    const record: OperatorRecord = {
      id: input.id,
      pubkeyAddress: input.pubkeyAddress.trim().toLowerCase(),
      displayName: input.displayName ?? null,
      status: 'active',
      createdAt: input.createdAt,
    }
    this.operators.push(record)
    return record
  }

  async findOperatorSessionByHash(hash: string, now: string): Promise<OperatorSessionRecord | null> {
    const session = this.operatorSessions.find((candidate) => candidate.sessionHash === hash) ?? null
    if (!session) return null
    if (Date.parse(session.expiresAt) <= Date.parse(now)) return null
    // Session is only usable while its operator is active.
    const operator = this.operators.find((op) => op.id === session.operatorId)
    if (!operator || operator.status !== 'active') return null
    return session
  }

  async createOperatorSession(input: {
    id: string
    operatorId: string
    sessionHash: string
    expiresAt: string
  }): Promise<OperatorSessionRecord> {
    const record: OperatorSessionRecord = {
      id: input.id,
      operatorId: input.operatorId,
      sessionHash: input.sessionHash,
      expiresAt: input.expiresAt,
    }
    this.operatorSessions.push(record)
    return record
  }

  async createInvite(invite: AccountInvite): Promise<AccountInvite> {
    this.invites.push(invite)
    return invite
  }

  async listInvites(input: { operatorId?: string; accountId?: string } = {}): Promise<AccountInvite[]> {
    return this.invites
      .filter((invite) => (input.accountId ? invite.accountId === input.accountId : true))
      .filter((invite) => {
        if (!input.operatorId) return true
        const account = this.accounts.find((candidate) => candidate.id === invite.accountId)
        return account?.operatorId === input.operatorId
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
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

  async revokeInvite(inviteId: string, now: string): Promise<AccountInvite | null> {
    const invite = this.invites.find((candidate) => candidate.id === inviteId)
    if (!invite) return null
    invite.status = 'revoked'
    invite.acceptedAt = invite.acceptedAt ?? now
    return invite
  }

  async deleteInvite(inviteId: string): Promise<AccountInvite | null> {
    const index = this.invites.findIndex((candidate) => candidate.id === inviteId)
    if (index < 0) return null
    const [invite] = this.invites.splice(index, 1)
    return invite
  }

  async getAccount(accountId: string): Promise<GatewayAccountRecord | null> {
    return this.accounts.find((account) => account.id === accountId) ?? null
  }

  async listAccounts(operatorId?: string): Promise<GatewayAccountRecord[]> {
    if (!operatorId) return this.accounts
    return this.accounts.filter((account) => account.operatorId === operatorId)
  }

  async createAccount(account: GatewayAccountRecord): Promise<GatewayAccountRecord> {
    this.accounts.push(account)
    return account
  }

  async updateAccount(input: {
    accountId: string
    displayName?: string
    defaultModel?: string
    modelAllowlist?: string[] | null
    status?: GatewayAccountRecord['status']
    now: string
  }): Promise<GatewayAccountRecord | null> {
    const account = await this.getAccount(input.accountId)
    if (!account) return null
    if (input.displayName !== undefined) account.displayName = input.displayName
    if (input.defaultModel !== undefined) account.defaultModel = input.defaultModel
    if (input.modelAllowlist !== undefined) account.modelAllowlist = input.modelAllowlist
    if (input.status !== undefined) account.status = input.status
    account.updatedAt = input.now
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
    const visibleRules = this.routingRules.filter(
      (rule) => ruleVisibleToAccount(account, rule) && modelAllowedForAccount(account, rule.requestedModel)
    )
    const visibleChannels = this.channels.filter(
      (channel) => ownerMatchesAccount(account, channel.operatorId) && channelIsRoutableForRules(channel, visibleRules)
    )

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
      channels: visibleChannels.map((channel) => ({
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
      routingRules: visibleRules.map((rule) => ({
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
      creditRequests: this.creditRequests
        .filter((row) => row.accountId === accountId)
        .map((row) => ({
          id: row.id,
          requestedMicroUsd: row.requestedMicroUsd,
          message: row.message,
          status: row.status,
          createdAt: row.createdAt,
        })),
    }
  }

  async listModels(accountId: string): Promise<string[]> {
    const account = await this.getAccount(accountId)
    if (!account) throw new Error('account_not_found')
    const visibleRules = this.routingRules.filter(
      (rule) =>
        rule.status === 'active' &&
        ruleVisibleToAccount(account, rule) &&
        modelAllowedForAccount(account, rule.requestedModel)
    )
    const activeChannelIds = new Set(
      this.channels
        .filter((channel) => channel.status === 'active' && ownerMatchesAccount(account, channel.operatorId))
        .map((channel) => channel.id)
    )
    return [
      ...new Set(
        visibleRules
          .filter((rule) => activeChannelIds.has(rule.providerTokenId))
          .map((rule) => rule.requestedModel)
      ),
    ].sort()
  }

  async listUsage(accountId: string): Promise<RequestLog[]> {
    return this.usage.filter((row) => row.accountId === accountId)
  }

  async listRecentRequestLogs(input: { limit?: number } = {}): Promise<RequestLog[]> {
    const limit = Math.max(1, Math.min(500, input.limit ?? 100))
    return [...this.usage].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit)
  }

  async setProviderTokenStatus(input: { id: string; status: 'active' | 'disabled'; now: string }): Promise<void> {
    const token = this.providerTokens.find((t) => t.id === input.id)
    if (token) {
      token.status = input.status
      token.updatedAt = input.now
    }
    const channel = this.channels.find((c) => c.id === input.id)
    if (channel) channel.status = input.status === 'active' ? 'active' : 'disabled'
  }

  async isOnchainTopupConsumed(input: { chainId: number; txHash: string; logIndex: number }): Promise<boolean> {
    return this.onchainTopups.some(
      (t) => t.chainId === input.chainId && t.txHash.toLowerCase() === input.txHash.toLowerCase() && t.logIndex === input.logIndex
    )
  }

  async recordOnchainTopup(record: OnchainTopupRecord): Promise<void> {
    this.onchainTopups.push(record)
  }

  async listOnchainTopups(input: { limit?: number } = {}): Promise<OnchainTopupRecord[]> {
    const limit = Math.max(1, Math.min(500, input.limit ?? 100))
    return [...this.onchainTopups].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit)
  }

  async createRedpacket(record: RedpacketRecord): Promise<void> {
    this.redpackets.push(record)
  }

  async getRedpacketByCodeHash(codeHash: string): Promise<RedpacketRecord | null> {
    return this.redpackets.find((r) => r.codeHash === codeHash) ?? null
  }

  async claimRedpacket(input: { id: string; account: string; toAddress: string; now: string }): Promise<boolean> {
    const r = this.redpackets.find((p) => p.id === input.id)
    if (!r || r.status !== 'unclaimed') return false
    r.status = 'claimed'
    r.claimedByAccount = input.account
    r.claimedToAddress = input.toAddress.toLowerCase()
    r.claimedAt = input.now
    return true
  }

  async setRedpacketClaimTx(input: { id: string; txHash: string }): Promise<void> {
    const r = this.redpackets.find((p) => p.id === input.id)
    if (r) r.claimTxHash = input.txHash.toLowerCase()
  }

  async revertRedpacketClaim(input: { id: string }): Promise<void> {
    const r = this.redpackets.find((p) => p.id === input.id)
    if (r) {
      r.status = 'unclaimed'
      r.claimedByAccount = undefined
      r.claimedToAddress = undefined
      r.claimedAt = undefined
      r.claimTxHash = undefined
    }
  }

  async listRedpackets(input: { limit?: number } = {}): Promise<RedpacketRecord[]> {
    const limit = Math.max(1, Math.min(500, input.limit ?? 100))
    return [...this.redpackets].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit)
  }

  async listPriceBook(): Promise<PriceBookRow[]> {
    return this.priceBook
  }

  async listRoutingRules(operatorId?: string): Promise<RoutingRule[]> {
    if (!operatorId) return this.routingRules
    return this.routingRules.filter((rule) => rule.operatorId === operatorId)
  }

  async listProviderTokenSummaries(operatorId?: string): Promise<ChannelRecord[]> {
    if (!operatorId) return this.channels
    return this.channels.filter((channel) => channel.operatorId === operatorId)
  }

  async getProviderToken(providerTokenId: string): Promise<ProviderTokenRecord | null> {
    return this.providerTokens.find((token) => token.id === providerTokenId) ?? null
  }

  async upsertProviderToken(input: {
    token: ProviderTokenRecord
    models: string[]
    priority?: number
    weight?: number
    operatorId?: string | null
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
      operatorId: input.operatorId ?? null,
      baseUrl: input.token.baseUrl ?? null,
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

  async createCreditRequest(record: CreditRequestRecord): Promise<CreditRequestRecord> {
    this.creditRequests.push(record)
    return record
  }

  async listCreditRequests(input: {
    accountId?: string
    statusFilter?: CreditRequestStatus
    limit?: number
  }): Promise<CreditRequestRecord[]> {
    const limit = input.limit ?? 100
    return this.creditRequests
      .filter((row) => (input.accountId ? row.accountId === input.accountId : true))
      .filter((row) => (input.statusFilter ? row.status === input.statusFilter : true))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit)
  }

  async getCreditRequest(id: string): Promise<CreditRequestRecord | null> {
    return this.creditRequests.find((row) => row.id === id) ?? null
  }

  async resolveCreditRequest(input: {
    id: string
    decision: 'approve' | 'reject'
    resolvedBy: string
    now: string
  }): Promise<{ record: CreditRequestRecord; ok: true } | { record: CreditRequestRecord; ok: false; reason: 'already_resolved' }> {
    const record = this.creditRequests.find((row) => row.id === input.id)
    if (!record) throw new Error('credit_request_not_found')
    if (record.status !== 'pending') {
      return { record, ok: false, reason: 'already_resolved' }
    }
    if (input.decision === 'approve') {
      const account = await this.getAccount(record.accountId)
      if (!account) throw new Error('account_not_found')
      account.balanceMicroUsd += record.requestedMicroUsd
      account.updatedAt = input.now
      this.ledger.push({
        id: `cr_${record.id}`,
        accountId: record.accountId,
        type: 'credit',
        amountMicroUsd: record.requestedMicroUsd,
        createdAt: input.now,
      })
      record.status = 'approved'
    } else {
      record.status = 'rejected'
    }
    record.resolvedAt = input.now
    record.resolvedBy = input.resolvedBy
    return { record, ok: true }
  }

  async recordAdminAudit(record: AdminAuditRecord): Promise<AdminAuditRecord> {
    this.auditLog.push(record)
    return record
  }

  async listAdminAudit(input: {
    limit?: number
    since?: string
    actorFilter?: string
  }): Promise<AdminAuditRecord[]> {
    const limit = input.limit ?? 100
    return this.auditLog
      .filter((row) => (input.actorFilter ? row.actor === input.actorFilter : true))
      .filter((row) => (input.since ? Date.parse(row.createdAt) >= Date.parse(input.since) : true))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit)
  }

  async recordTreasuryCredit(record: TreasuryCreditRecord): Promise<void> {
    // Idempotent on the on-chain payment tx (mirrors the D1 UNIQUE index).
    if (this.treasuryCredits.some((row) => row.stablecoinTxHash === record.stablecoinTxHash)) return
    this.treasuryCredits.push(record)
  }

  async recordTreasuryWithdrawal(record: TreasuryWithdrawalRecord): Promise<void> {
    this.treasuryWithdrawals.push(record)
  }

  async getOperatorRevenue(operatorId: string): Promise<OperatorRevenue> {
    const credited = this.treasuryCredits
      .filter((row) => row.operatorId === operatorId)
      .reduce((sum, row) => sum + row.amountMicroUsd, 0)
    const withdrawn = this.treasuryWithdrawals
      .filter((row) => row.operatorId === operatorId)
      .reduce((sum, row) => sum + row.amountMicroUsd, 0)
    const operatorAccountIds = new Set(
      this.accounts.filter((account) => account.operatorId === operatorId).map((account) => account.id)
    )
    const logs = this.usage.filter((row) => operatorAccountIds.has(row.accountId))
    const sell = logs.reduce((sum, row) => sum + (row.sellCostMicroUsd ?? 0), 0)
    const upstream = logs.reduce((sum, row) => sum + (row.upstreamCostMicroUsd ?? 0), 0)
    const totalTokens = logs.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0)
    return {
      treasuryCreditedMicroUsd: credited,
      treasuryWithdrawnMicroUsd: withdrawn,
      sellMicroUsd: sell,
      upstreamMicroUsd: upstream,
      marginMicroUsd: sell - upstream,
      calls: logs.length,
      totalTokens,
    }
  }

  async claimStablecoinFaucet(record: StablecoinFaucetClaimRecord): Promise<boolean> {
    if (this.stablecoinFaucetClaims.some((claim) => claim.accountId === record.accountId)) return false
    this.stablecoinFaucetClaims.push(record)
    return true
  }

  async setStablecoinFaucetTx(input: { id: string; txHash: string }): Promise<void> {
    const claim = this.stablecoinFaucetClaims.find((row) => row.id === input.id)
    if (claim) claim.txHash = input.txHash.toLowerCase()
  }

  async revertStablecoinFaucetClaim(input: { id: string }): Promise<void> {
    const idx = this.stablecoinFaucetClaims.findIndex((row) => row.id === input.id)
    if (idx >= 0) this.stablecoinFaucetClaims.splice(idx, 1)
  }
}

export interface D1RunResult {
  success?: boolean
  meta?: { changes?: number; rows_written?: number; rows_read?: number }
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch?(statements: D1PreparedStatement[]): Promise<D1RunResult[]>
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<D1RunResult>
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

  async findOperatorByAddress(address: string): Promise<OperatorRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM compute_operators WHERE pubkey_address = ? LIMIT 1')
      .bind(address.trim().toLowerCase())
      .first<Record<string, unknown>>()
    if (!row) return null
    return {
      id: stringValue(row.id),
      pubkeyAddress: stringValue(row.pubkey_address),
      displayName: row.display_name == null ? null : stringValue(row.display_name),
      status: stringValue(row.status) === 'disabled' ? 'disabled' : 'active',
      createdAt: stringValue(row.created_at),
    }
  }

  async createOperator(input: {
    id: string
    pubkeyAddress: string
    displayName?: string | null
    createdAt: string
  }): Promise<OperatorRecord> {
    await this.db
      .prepare(
        'INSERT INTO compute_operators (id, pubkey_address, display_name, status, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .bind(input.id, input.pubkeyAddress.trim().toLowerCase(), input.displayName ?? null, 'active', input.createdAt)
      .run()
    return {
      id: input.id,
      pubkeyAddress: input.pubkeyAddress.trim().toLowerCase(),
      displayName: input.displayName ?? null,
      status: 'active',
      createdAt: input.createdAt,
    }
  }

  async findOperatorSessionByHash(hash: string, now: string): Promise<OperatorSessionRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT s.id AS id, s.operator_id AS operator_id, s.session_hash AS session_hash, s.expires_at AS expires_at
         FROM compute_operator_sessions s
         JOIN compute_operators o ON o.id = s.operator_id
         WHERE s.session_hash = ? AND s.expires_at > ? AND o.status = 'active' LIMIT 1`
      )
      .bind(hash, now)
      .first<Record<string, unknown>>()
    if (!row) return null
    return {
      id: stringValue(row.id),
      operatorId: stringValue(row.operator_id),
      sessionHash: stringValue(row.session_hash),
      expiresAt: stringValue(row.expires_at),
    }
  }

  async createOperatorSession(input: {
    id: string
    operatorId: string
    sessionHash: string
    expiresAt: string
  }): Promise<OperatorSessionRecord> {
    await this.db
      .prepare(
        'INSERT INTO compute_operator_sessions (id, operator_id, session_hash, expires_at) VALUES (?, ?, ?, ?)'
      )
      .bind(input.id, input.operatorId, input.sessionHash, input.expiresAt)
      .run()
    return input
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

  async listInvites(input: { operatorId?: string; accountId?: string } = {}): Promise<AccountInvite[]> {
    const conditions: string[] = []
    const binds: unknown[] = []
    if (input.operatorId) {
      conditions.push('a.operator_id = ?')
      binds.push(input.operatorId)
    }
    if (input.accountId) {
      conditions.push('i.account_id = ?')
      binds.push(input.accountId)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = await this.db
      .prepare(
        `SELECT i.* FROM compute_account_invites i JOIN compute_accounts a ON a.id = i.account_id ${where} ORDER BY i.created_at DESC`
      )
      .bind(...binds)
      .all<Record<string, unknown>>()
    return rows.results.map((row) => this.inviteFromRow(row))
  }

  async findInviteByHash(hash: string): Promise<AccountInvite | null> {
    const row = await this.db
      .prepare('SELECT * FROM compute_account_invites WHERE invite_token_hash = ? LIMIT 1')
      .bind(hash)
      .first<Record<string, unknown>>()
    if (!row) return null
    return this.inviteFromRow(row)
  }

  async markInviteAccepted(inviteId: string, now: string): Promise<void> {
    await this.db
      .prepare('UPDATE compute_account_invites SET status = ?, accepted_at = ? WHERE id = ?')
      .bind('accepted', now, inviteId)
      .run()
  }

  async revokeInvite(inviteId: string, now: string): Promise<AccountInvite | null> {
    await this.db
      .prepare("UPDATE compute_account_invites SET status = 'revoked', accepted_at = COALESCE(accepted_at, ?) WHERE id = ?")
      .bind(now, inviteId)
      .run()
    const row = await this.db
      .prepare('SELECT * FROM compute_account_invites WHERE id = ? LIMIT 1')
      .bind(inviteId)
      .first<Record<string, unknown>>()
    return row ? this.inviteFromRow(row) : null
  }

  async deleteInvite(inviteId: string): Promise<AccountInvite | null> {
    const row = await this.db
      .prepare('SELECT * FROM compute_account_invites WHERE id = ? LIMIT 1')
      .bind(inviteId)
      .first<Record<string, unknown>>()
    if (!row) return null
    await this.db.prepare('DELETE FROM compute_account_invites WHERE id = ?').bind(inviteId).run()
    return this.inviteFromRow(row)
  }

  private inviteFromRow(row: Record<string, unknown>): AccountInvite {
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
      operatorId: optionalString(row.operator_id) ?? null,
      balanceMicroUsd: numberValue(latestLedger?.balance_after_micro_usd),
      reservedMicroUsd: 0,
      defaultProvider: stringValue(row.default_provider),
      defaultModel: optionalString(row.default_model),
      modelAllowlist: await this.listAccountModelAllowlist(accountId),
      createdAt: stringValue(row.created_at),
      updatedAt: stringValue(row.updated_at),
    }
  }

  async listAccounts(operatorId?: string): Promise<GatewayAccountRecord[]> {
    const rows = operatorId
      ? await this.db
          .prepare('SELECT id FROM compute_accounts WHERE operator_id = ? ORDER BY created_at DESC')
          .bind(operatorId)
          .all<Record<string, unknown>>()
      : await this.db.prepare('SELECT id FROM compute_accounts ORDER BY created_at DESC').all<Record<string, unknown>>()
    const accounts = await Promise.all(rows.results.map((row) => this.getAccount(stringValue(row.id))))
    return accounts.filter((account): account is GatewayAccountRecord => Boolean(account))
  }

  async createAccount(account: GatewayAccountRecord): Promise<GatewayAccountRecord> {
    await this.db
      .prepare(
        'INSERT INTO compute_accounts (id, display_name, status, account_group, default_provider, default_model, operator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        account.id,
        account.displayName,
        account.status,
        account.accountGroup,
        account.defaultProvider,
        account.defaultModel ?? null,
        account.operatorId ?? null,
        account.createdAt,
        account.updatedAt
      )
      .run()
    if (account.modelAllowlist !== undefined) {
      await this.replaceAccountModelAllowlist(account.id, account.modelAllowlist, account.createdAt)
    }
    return account
  }

  async updateAccount(input: {
    accountId: string
    displayName?: string
    defaultModel?: string
    modelAllowlist?: string[] | null
    status?: GatewayAccountRecord['status']
    now: string
  }): Promise<GatewayAccountRecord | null> {
    const account = await this.getAccount(input.accountId)
    if (!account) return null

    await this.db
      .prepare(
        'UPDATE compute_accounts SET display_name = COALESCE(?, display_name), default_model = COALESCE(?, default_model), status = COALESCE(?, status), updated_at = ? WHERE id = ?'
      )
      .bind(input.displayName ?? null, input.defaultModel ?? null, input.status ?? null, input.now, input.accountId)
      .run()
    if (input.modelAllowlist !== undefined) {
      await this.replaceAccountModelAllowlist(input.accountId, input.modelAllowlist, input.now)
    }
    return this.getAccount(input.accountId)
  }

  private async listAccountModelAllowlist(accountId: string): Promise<string[] | null> {
    const rows = await this.db
      .prepare('SELECT model FROM compute_model_allowlist WHERE account_id = ? ORDER BY model')
      .bind(accountId)
      .all<Record<string, unknown>>()
    const models = rows.results.map((row) => stringValue(row.model)).filter(Boolean)
    return models.length > 0 ? models : null
  }

  private async replaceAccountModelAllowlist(
    accountId: string,
    modelAllowlist: string[] | null | undefined,
    now: string
  ): Promise<void> {
    await this.db.prepare('DELETE FROM compute_model_allowlist WHERE account_id = ?').bind(accountId).run()
    const models = [...new Set((modelAllowlist ?? []).map((model) => model.trim()).filter(Boolean))]
    await Promise.all(
      models.map((model) =>
        this.db
          .prepare('INSERT INTO compute_model_allowlist (account_id, provider, model, created_at) VALUES (?, ?, ?, ?)')
          .bind(accountId, '*', model, now)
          .run()
      )
    )
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
      creditRequests: await this.listCreditRequests({ accountId }),
    })
    return memory.getDashboardSnapshot(accountId)
  }

  async listModels(accountId: string): Promise<string[]> {
    const snapshot = await this.getDashboardSnapshot(accountId)
    const activeChannelLabels = new Set(
      snapshot.channels.filter((channel) => channel.status === 'active').map((channel) => channel.label)
    )
    return [
      ...new Set(
        snapshot.routingRules
          .filter((rule) => rule.status === 'active' && activeChannelLabels.has(rule.channelLabel))
          .map((rule) => rule.requestedModel)
      ),
    ].sort()
  }

  async listUsage(accountId: string): Promise<RequestLog[]> {
    const rows = await this.db
      .prepare('SELECT * FROM compute_request_logs WHERE account_id = ? ORDER BY created_at DESC LIMIT 100')
      .bind(accountId)
      .all<Record<string, unknown>>()
    return rows.results.map((row) => mapRequestLogRow(row))
  }

  async listRecentRequestLogs(input: { limit?: number } = {}): Promise<RequestLog[]> {
    const limit = Math.max(1, Math.min(500, input.limit ?? 100))
    const rows = await this.db
      .prepare('SELECT * FROM compute_request_logs ORDER BY created_at DESC LIMIT ?')
      .bind(limit)
      .all<Record<string, unknown>>()
    return rows.results.map((row) => mapRequestLogRow(row))
  }

  async setProviderTokenStatus(input: { id: string; status: 'active' | 'disabled'; now: string }): Promise<void> {
    await this.db
      .prepare('UPDATE compute_provider_tokens SET status = ?, exhausted_until = NULL, last_error = NULL, updated_at = ? WHERE id = ?')
      .bind(input.status, input.now, input.id)
      .run()
  }

  async isOnchainTopupConsumed(input: { chainId: number; txHash: string; logIndex: number }): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT id FROM compute_onchain_topups WHERE chain_id = ? AND tx_hash = ? AND log_index = ? LIMIT 1')
      .bind(input.chainId, input.txHash.toLowerCase(), input.logIndex)
      .first<Record<string, unknown>>()
    return row != null
  }

  async recordOnchainTopup(record: OnchainTopupRecord): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO compute_onchain_topups (id, chain_id, tx_hash, log_index, account_id, token_address, from_address, to_address, amount_raw, credited_micro_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        record.id,
        record.chainId,
        record.txHash.toLowerCase(),
        record.logIndex,
        record.accountId,
        record.tokenAddress.toLowerCase(),
        record.fromAddress.toLowerCase(),
        record.toAddress.toLowerCase(),
        record.amountRaw,
        record.creditedMicroUsd,
        record.createdAt
      )
      .run()
  }

  async listOnchainTopups(input: { limit?: number } = {}): Promise<OnchainTopupRecord[]> {
    const limit = Math.max(1, Math.min(500, input.limit ?? 100))
    const rows = await this.db
      .prepare('SELECT * FROM compute_onchain_topups ORDER BY created_at DESC LIMIT ?')
      .bind(limit)
      .all<Record<string, unknown>>()
    return rows.results.map((row) => ({
      id: stringValue(row.id),
      chainId: numberValue(row.chain_id),
      txHash: stringValue(row.tx_hash),
      logIndex: numberValue(row.log_index),
      accountId: stringValue(row.account_id),
      tokenAddress: stringValue(row.token_address),
      fromAddress: stringValue(row.from_address),
      toAddress: stringValue(row.to_address),
      amountRaw: stringValue(row.amount_raw),
      creditedMicroUsd: numberValue(row.credited_micro_usd),
      createdAt: stringValue(row.created_at),
    }))
  }

  async createRedpacket(record: RedpacketRecord): Promise<void> {
    await this.db
      .prepare('INSERT INTO compute_redpackets (id, code_hash, amount_raw, label, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(record.id, record.codeHash, record.amountRaw, record.label ?? null, record.status, record.createdAt)
      .run()
  }

  async getRedpacketByCodeHash(codeHash: string): Promise<RedpacketRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM compute_redpackets WHERE code_hash = ? LIMIT 1')
      .bind(codeHash)
      .first<Record<string, unknown>>()
    if (!row) return null
    return {
      id: stringValue(row.id),
      codeHash: stringValue(row.code_hash),
      amountRaw: stringValue(row.amount_raw),
      label: optionalString(row.label),
      status: stringValue(row.status) === 'claimed' ? 'claimed' : 'unclaimed',
      claimedByAccount: optionalString(row.claimed_by_account),
      claimedToAddress: optionalString(row.claimed_to_address),
      claimTxHash: optionalString(row.claim_tx_hash),
      createdAt: stringValue(row.created_at),
      claimedAt: optionalString(row.claimed_at),
    }
  }

  async claimRedpacket(input: { id: string; account: string; toAddress: string; now: string }): Promise<boolean> {
    const res = await this.db
      .prepare("UPDATE compute_redpackets SET status='claimed', claimed_by_account=?, claimed_to_address=?, claimed_at=? WHERE id=? AND status='unclaimed'")
      .bind(input.account, input.toAddress.toLowerCase(), input.now, input.id)
      .run()
    return (res.meta?.changes ?? 0) > 0
  }

  async setRedpacketClaimTx(input: { id: string; txHash: string }): Promise<void> {
    await this.db
      .prepare('UPDATE compute_redpackets SET claim_tx_hash=? WHERE id=?')
      .bind(input.txHash.toLowerCase(), input.id)
      .run()
  }

  async revertRedpacketClaim(input: { id: string }): Promise<void> {
    await this.db
      .prepare("UPDATE compute_redpackets SET status='unclaimed', claimed_by_account=NULL, claimed_to_address=NULL, claimed_at=NULL, claim_tx_hash=NULL WHERE id=?")
      .bind(input.id)
      .run()
  }

  async listRedpackets(input: { limit?: number } = {}): Promise<RedpacketRecord[]> {
    const limit = Math.max(1, Math.min(500, input.limit ?? 100))
    const rows = await this.db
      .prepare('SELECT * FROM compute_redpackets ORDER BY created_at DESC LIMIT ?')
      .bind(limit)
      .all<Record<string, unknown>>()
    return rows.results.map((row) => ({
      id: stringValue(row.id),
      codeHash: stringValue(row.code_hash),
      amountRaw: stringValue(row.amount_raw),
      label: optionalString(row.label),
      status: stringValue(row.status) === 'claimed' ? 'claimed' : 'unclaimed',
      claimedByAccount: optionalString(row.claimed_by_account),
      claimedToAddress: optionalString(row.claimed_to_address),
      claimTxHash: optionalString(row.claim_tx_hash),
      createdAt: stringValue(row.created_at),
      claimedAt: optionalString(row.claimed_at),
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

  async listProviderTokenSummaries(operatorId?: string): Promise<ChannelRecord[]> {
    const channels = await this.listChannels()
    if (!operatorId) return channels
    return channels.filter((channel) => channel.operatorId === operatorId)
  }

  async listRoutingRules(operatorId?: string): Promise<RoutingRule[]> {
    const rules = await this.queryRoutingRules()
    if (!operatorId) return rules
    return rules.filter((rule) => rule.operatorId === operatorId)
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
      baseUrl: optionalString(row.base_url) ?? null,
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
    operatorId?: string | null
    now: string
  }): Promise<ChannelRecord> {
    await this.db
      .prepare(
        'INSERT OR REPLACE INTO compute_provider_tokens (id, provider, label, adapter, base_url, models_json, status, scope_json, secret_ref, ciphertext, nonce, key_version, derivation_fingerprint, success_count, failure_count, exhausted_until, last_error, last_response_ms, last_used_at, rotated_at, operator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        input.token.id,
        input.token.provider,
        input.token.label,
        input.token.adapter,
        input.token.baseUrl ?? null,
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
        input.operatorId ?? null,
        input.token.createdAt,
        input.now
      )
      .run()

    return {
      id: input.token.id,
      label: input.token.label,
      provider: input.token.provider,
      adapter: input.token.adapter,
      operatorId: input.operatorId ?? null,
      baseUrl: input.token.baseUrl ?? null,
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
        'INSERT OR REPLACE INTO compute_routing_rules (id, account_group, requested_provider, requested_model, provider_token_id, actual_provider_model, priority, weight, status, operator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
        input.rule.operatorId ?? null,
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
      operatorId: optionalString(row.operator_id) ?? null,
      baseUrl: optionalString(row.base_url) ?? null,
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
      operatorId: optionalString(row.operator_id) ?? null,
    }))
  }

  async createCreditRequest(record: CreditRequestRecord): Promise<CreditRequestRecord> {
    await this.db
      .prepare(
        'INSERT INTO compute_credit_requests (id, account_id, requested_micro_usd, message, status, created_at, resolved_at, resolved_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        record.id,
        record.accountId,
        record.requestedMicroUsd,
        record.message ?? null,
        record.status,
        record.createdAt,
        record.resolvedAt ?? null,
        record.resolvedBy ?? null
      )
      .run()
    return record
  }

  async listCreditRequests(input: {
    accountId?: string
    statusFilter?: CreditRequestStatus
    limit?: number
  }): Promise<CreditRequestRecord[]> {
    const conditions: string[] = []
    const binds: unknown[] = []
    if (input.accountId) {
      conditions.push('account_id = ?')
      binds.push(input.accountId)
    }
    if (input.statusFilter) {
      conditions.push('status = ?')
      binds.push(input.statusFilter)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = input.limit ?? 100
    const rows = await this.db
      .prepare(`SELECT * FROM compute_credit_requests ${where} ORDER BY created_at DESC LIMIT ?`)
      .bind(...binds, limit)
      .all<Record<string, unknown>>()
    return rows.results.map((row) => this.creditRequestFromRow(row))
  }

  async getCreditRequest(id: string): Promise<CreditRequestRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM compute_credit_requests WHERE id = ? LIMIT 1')
      .bind(id)
      .first<Record<string, unknown>>()
    if (!row) return null
    return this.creditRequestFromRow(row)
  }

  async resolveCreditRequest(input: {
    id: string
    decision: 'approve' | 'reject'
    resolvedBy: string
    now: string
  }): Promise<{ record: CreditRequestRecord; ok: true } | { record: CreditRequestRecord; ok: false; reason: 'already_resolved' }> {
    const existing = await this.getCreditRequest(input.id)
    if (!existing) throw new Error('credit_request_not_found')
    if (existing.status !== 'pending') {
      return { record: existing, ok: false, reason: 'already_resolved' }
    }

    if (input.decision === 'reject') {
      const result = await this.db
        .prepare(
          "UPDATE compute_credit_requests SET status = 'rejected', resolved_at = ?, resolved_by = ? WHERE id = ? AND status = 'pending'"
        )
        .bind(input.now, input.resolvedBy, input.id)
        .run()
      const changes = result.meta?.changes ?? 0
      if (changes === 0) {
        const refetched = (await this.getCreditRequest(input.id)) ?? existing
        return { record: refetched, ok: false, reason: 'already_resolved' }
      }
      const refetched = (await this.getCreditRequest(input.id)) ?? existing
      return { record: refetched, ok: true }
    }

    const account = await this.getAccount(existing.accountId)
    if (!account) throw new Error('account_not_found')
    const balanceAfter = account.balanceMicroUsd + existing.requestedMicroUsd

    const stmts: D1PreparedStatement[] = [
      this.db
        .prepare(
          "UPDATE compute_credit_requests SET status = 'approved', resolved_at = ?, resolved_by = ? WHERE id = ? AND status = 'pending'"
        )
        .bind(input.now, input.resolvedBy, input.id),
      this.db
        .prepare(
          'INSERT OR IGNORE INTO compute_ledger_entries (id, account_id, type, amount_micro_usd, balance_after_micro_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .bind(`cr_${input.id}`, existing.accountId, 'credit', existing.requestedMicroUsd, balanceAfter, input.now),
    ]
    let updateChanges: number
    let insertChanges: number
    if (this.db.batch) {
      const results = await this.db.batch(stmts)
      updateChanges = results[0]?.meta?.changes ?? 0
      insertChanges = results[1]?.meta?.changes ?? 0
    } else {
      const updateRes = await stmts[0].run()
      updateChanges = updateRes.meta?.changes ?? 0
      if (updateChanges === 0) {
        const refetched = (await this.getCreditRequest(input.id)) ?? existing
        return { record: refetched, ok: false, reason: 'already_resolved' }
      }
      const insertRes = await stmts[1].run()
      insertChanges = insertRes.meta?.changes ?? 0
    }
    if (updateChanges === 0) {
      const refetched = (await this.getCreditRequest(input.id)) ?? existing
      return { record: refetched, ok: false, reason: 'already_resolved' }
    }
    if (insertChanges === 0) {
      // Ledger row already existed (cr_<id> collision) — a prior approve had
      // committed but its UPDATE was missed. Treat as already resolved so we
      // never double-credit. The duplicate UPDATE we just ran is harmless: it
      // overwrites resolved_at/resolved_by on an already-approved row.
      const refetched = (await this.getCreditRequest(input.id)) ?? existing
      return { record: refetched, ok: false, reason: 'already_resolved' }
    }
    const refetched = (await this.getCreditRequest(input.id)) ?? existing
    return { record: refetched, ok: true }
  }

  private creditRequestFromRow(row: Record<string, unknown>): CreditRequestRecord {
    const status = stringValue(row.status)
    return {
      id: stringValue(row.id),
      accountId: stringValue(row.account_id),
      requestedMicroUsd: numberValue(row.requested_micro_usd),
      message: optionalString(row.message),
      status: status === 'approved' || status === 'rejected' ? status : 'pending',
      createdAt: stringValue(row.created_at),
      resolvedAt: optionalString(row.resolved_at) ?? null,
      resolvedBy: optionalString(row.resolved_by) ?? null,
    }
  }

  async recordAdminAudit(record: AdminAuditRecord): Promise<AdminAuditRecord> {
    await this.db
      .prepare(
        'INSERT INTO compute_admin_audit_log (id, actor, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        record.id,
        record.actor,
        record.action,
        record.targetType,
        record.targetId,
        JSON.stringify(record.metadata ?? {}),
        record.createdAt
      )
      .run()
    return record
  }

  async listAdminAudit(input: {
    limit?: number
    since?: string
    actorFilter?: string
  }): Promise<AdminAuditRecord[]> {
    const conditions: string[] = []
    const binds: unknown[] = []
    if (input.actorFilter) {
      conditions.push('actor = ?')
      binds.push(input.actorFilter)
    }
    if (input.since) {
      conditions.push('created_at >= ?')
      binds.push(input.since)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = input.limit ?? 100
    const rows = await this.db
      .prepare(`SELECT * FROM compute_admin_audit_log ${where} ORDER BY created_at DESC LIMIT ?`)
      .bind(...binds, limit)
      .all<Record<string, unknown>>()
    return rows.results.map((row) => ({
      id: stringValue(row.id),
      actor: stringValue(row.actor),
      action: stringValue(row.action),
      targetType: stringValue(row.target_type),
      targetId: stringValue(row.target_id),
      metadata: parseJsonObject(row.metadata_json),
      createdAt: stringValue(row.created_at),
    }))
  }

  async recordTreasuryCredit(record: TreasuryCreditRecord): Promise<void> {
    // INSERT OR IGNORE keys off the UNIQUE(stablecoin_tx_hash) index: a replayed
    // buy-myc with the same on-chain payment can never double-credit a treasury.
    await this.db
      .prepare(
        'INSERT OR IGNORE INTO compute_treasury_credits (id, operator_id, account_id, amount_micro_usd, stablecoin_tx_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .bind(
        record.id,
        record.operatorId,
        record.accountId ?? null,
        record.amountMicroUsd,
        record.stablecoinTxHash.toLowerCase(),
        record.createdAt
      )
      .run()
  }

  async recordTreasuryWithdrawal(record: TreasuryWithdrawalRecord): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO compute_treasury_withdrawals (id, operator_id, amount_micro_usd, to_address, tx_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .bind(
        record.id,
        record.operatorId,
        record.amountMicroUsd,
        record.toAddress.toLowerCase(),
        record.txHash.toLowerCase(),
        record.createdAt
      )
      .run()
  }

  async getOperatorRevenue(operatorId: string): Promise<OperatorRevenue> {
    const credited = await this.db
      .prepare('SELECT COALESCE(SUM(amount_micro_usd), 0) AS total FROM compute_treasury_credits WHERE operator_id = ?')
      .bind(operatorId)
      .first<Record<string, unknown>>()
    const withdrawn = await this.db
      .prepare('SELECT COALESCE(SUM(amount_micro_usd), 0) AS total FROM compute_treasury_withdrawals WHERE operator_id = ?')
      .bind(operatorId)
      .first<Record<string, unknown>>()
    // Margin joins logs to their owning account, scoped to this operator.
    const margin = await this.db
      .prepare(
        `SELECT
           COALESCE(SUM(l.sell_cost_micro_usd), 0) AS sell,
           COALESCE(SUM(l.upstream_cost_micro_usd), 0) AS upstream,
           COALESCE(SUM(l.total_tokens), 0) AS tokens,
           COUNT(*) AS calls
         FROM compute_request_logs l
         JOIN compute_accounts a ON a.id = l.account_id
         WHERE a.operator_id = ?`
      )
      .bind(operatorId)
      .first<Record<string, unknown>>()
    const sell = numberValue(margin?.sell)
    const upstream = numberValue(margin?.upstream)
    return {
      treasuryCreditedMicroUsd: numberValue(credited?.total),
      treasuryWithdrawnMicroUsd: numberValue(withdrawn?.total),
      sellMicroUsd: sell,
      upstreamMicroUsd: upstream,
      marginMicroUsd: sell - upstream,
      calls: numberValue(margin?.calls),
      totalTokens: numberValue(margin?.tokens),
    }
  }

  async claimStablecoinFaucet(record: StablecoinFaucetClaimRecord): Promise<boolean> {
    const res = await this.db
      .prepare(
        'INSERT OR IGNORE INTO compute_stablecoin_faucet_claims (id, account_id, to_address, amount_raw, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .bind(record.id, record.accountId, record.toAddress.toLowerCase(), record.amountRaw, record.createdAt)
      .run()
    return (res.meta?.changes ?? 0) > 0
  }

  async setStablecoinFaucetTx(input: { id: string; txHash: string }): Promise<void> {
    await this.db
      .prepare('UPDATE compute_stablecoin_faucet_claims SET tx_hash=? WHERE id=?')
      .bind(input.txHash.toLowerCase(), input.id)
      .run()
  }

  async revertStablecoinFaucetClaim(input: { id: string }): Promise<void> {
    await this.db.prepare('DELETE FROM compute_stablecoin_faucet_claims WHERE id=?').bind(input.id).run()
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

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
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

function mapRequestLogRow(row: Record<string, unknown>): RequestLog {
  return {
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
    errorCode: optionalString(row.error_code),
  }
}

import { useEffect, useMemo, useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  buildDefaultComputeGatewayPricePayload,
  buildDefaultComputeGatewayRoutingPayload,
  buildProviderTokenSetupPayload,
  COMPUTE_GATEWAY_PROVIDER_PRESETS,
  DEFAULT_PUBLIC_COMPUTE_GATEWAY_URL,
  findConfiguredProviderForComputeProvider,
  findStoredCredentialForComputeProvider,
  getComputeProviderModelOptions,
  normalizeComputeGatewayUrl,
} from '../utils/computeGateway'
import type { ProviderConfig } from '../types/provider'
import './ComputeGatewayManager.css'

const LS_URL = 'mykey_gateway_url'
const LS_INVITE_LINKS = 'mykey_gateway_invite_links_v1'
const ALL_PROVIDER_MODELS = '__all_provider_models__'

interface Account { id: string; display_name: string; status: string; balance_micro_usd: number; account_group: string; default_model?: string | null; model_allowlist?: string[] }
interface Channel { id: string; label: string; provider: string; status: string; base_url: string | null }
interface RoutingRule { id: string; account_group: string; requested_provider: string; requested_model: string; provider_token_id: string; status: string }
interface CreatedChannel { id: string; provider: string; models: string[] }
interface OperatorInvite { id: string; account_id: string; account_display_name: string; account_group: string; status: string; expires_at: string; created_at: string; accepted_at: string | null }
interface Revenue {
  treasury: { credited_micro_usd: number; withdrawn_micro_usd: number; withdrawable_micro_usd: number }
  margin: { sell_micro_usd: number; upstream_micro_usd: number; margin_micro_usd: number; calls: number; total_tokens: number }
  stablecoin: { token_address: string; chain_id: number; decimals: number } | null
}
interface PayoutOption { address: string; label: string }
interface ComputeGatewayManagerProps { masterPassword?: string; providers?: ProviderConfig[] }

function usd(micro: number) { return '$' + (micro / 1e6).toFixed(2) }

function readInviteLinks(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_INVITE_LINKS) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {}
  } catch {
    return {}
  }
}

function writeInviteLinks(next: Record<string, string>) {
  localStorage.setItem(LS_INVITE_LINKS, JSON.stringify(next))
}

// Operator-scoped gateway calls. Auth is the operator session (held server-side
// in the Rust vault, keyed by the local operator identity) — no Admin Token.
async function operatorGet<T>(url: string, masterPassword: string, path: string): Promise<T> {
  const text = await invoke<string>('compute_gateway_operator_request', { gatewayUrl: url, method: 'GET', path, body: null, masterPassword })
  return JSON.parse(text) as T
}
async function operatorPost<T>(url: string, masterPassword: string, path: string, body: unknown): Promise<T> {
  const text = await invoke<string>('compute_gateway_operator_request', { gatewayUrl: url, method: 'POST', path, body: JSON.stringify(body), masterPassword })
  return JSON.parse(text) as T
}
async function operatorPatch<T>(url: string, masterPassword: string, path: string, body: unknown): Promise<T> {
  const text = await invoke<string>('compute_gateway_operator_request', { gatewayUrl: url, method: 'PATCH', path, body: JSON.stringify(body), masterPassword })
  return JSON.parse(text) as T
}

export function ComputeGatewayManager({ masterPassword = '', providers = [] }: ComputeGatewayManagerProps) {
  const [url, setUrl] = useState(() => localStorage.getItem(LS_URL) ?? DEFAULT_PUBLIC_COMPUTE_GATEWAY_URL)
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [routingRules, setRoutingRules] = useState<RoutingRule[]>([])
  const [invites, setInvites] = useState<OperatorInvite[]>([])
  const [inviteLinksById, setInviteLinksById] = useState<Record<string, string>>(() => readInviteLinks())
  const [revenue, setRevenue] = useState<Revenue | null>(null)
  const [payoutOptions, setPayoutOptions] = useState<PayoutOption[]>([])
  const [payoutAddress, setPayoutAddress] = useState('')
  const [withdrawing, setWithdrawing] = useState(false)
  const [withdrawNote, setWithdrawNote] = useState('')
  const [error, setError] = useState('')
  // "邀请朋友" flow state.
  const [friendName, setFriendName] = useState('')
  const [friendModels, setFriendModels] = useState<string[]>([])
  const [friendRp, setFriendRp] = useState('10')
  const [inviteLink, setInviteLink] = useState('')
  const [inviteNote, setInviteNote] = useState('')
  const [inviting, setInviting] = useState(false)
  const [updatingAccountId, setUpdatingAccountId] = useState('')
  const [revokingInviteId, setRevokingInviteId] = useState('')
  const [providerPresetId, setProviderPresetId] = useState('bailian')
  const selectedPreset = COMPUTE_GATEWAY_PROVIDER_PRESETS.find((preset) => preset.id === providerPresetId) ?? COMPUTE_GATEWAY_PROVIDER_PRESETS[0]
  const [providerLabel, setProviderLabel] = useState(() => `${selectedPreset.label} shared token`)
  const [providerToken, setProviderToken] = useState('')
  const [providerModel, setProviderModel] = useState(() => selectedPreset.defaultModel)
  const [setupNote, setSetupNote] = useState('')
  const [setupSaving, setSetupSaving] = useState(false)
  const configuredProvider = useMemo(
    () => findConfiguredProviderForComputeProvider(providers, selectedPreset.provider),
    [providers, selectedPreset.provider]
  )
  const providerModelOptions = useMemo(
    () => getComputeProviderModelOptions(configuredProvider, selectedPreset.models),
    [configuredProvider, selectedPreset.models]
  )

  const refresh = useCallback(async (gatewayUrl = url) => {
    if (!masterPassword) return
    setError('')
    try {
      const [a, c, rr, inv, rev] = await Promise.all([
        operatorGet<{ data: Account[] }>(gatewayUrl, masterPassword, '/operator/accounts'),
        operatorGet<{ data: Channel[] }>(gatewayUrl, masterPassword, '/operator/provider-tokens'),
        operatorGet<{ data: RoutingRule[] }>(gatewayUrl, masterPassword, '/operator/routing-rules'),
        operatorGet<{ data: OperatorInvite[] }>(gatewayUrl, masterPassword, '/operator/invites').catch(() => ({ data: [] })),
        // Tolerate older gateways without the revenue endpoint — the panel just stays empty.
        operatorGet<Revenue>(gatewayUrl, masterPassword, '/operator/revenue').catch(() => null),
      ])
      setAccounts(a.data); setChannels(c.data); setRoutingRules(rr.data); setInvites(inv.data); setRevenue(rev)
      setConnected(true)
    } catch (e) { setError(String(e)); setConnected(false) }
  }, [url, masterPassword])

  // Connect = register/login this operator with its local key (Rust signs the
  // challenge + stores the session), then load the operator's own data.
  async function connect() {
    if (!masterPassword) { setError('请先解锁应用再连接网关'); return }
    const normalized = normalizeComputeGatewayUrl(url)
    setConnecting(true)
    setError('')
    try {
      await invoke('compute_gateway_operator_connect', { gatewayUrl: normalized, masterPassword })
      localStorage.setItem(LS_URL, normalized)
      setUrl(normalized)
      setConnected(true)
      setConnecting(false)
      void refresh(normalized)
    } catch (e) {
      setError(String(e)); setConnected(false)
      setConnecting(false)
    }
  }

  // Auto-connect once the app is unlocked — the operator identity is local, no
  // Admin Token to type. Fires once when masterPassword becomes available.
  useEffect(() => {
    if (masterPassword) void connect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masterPassword])

  // Auto-fill the upstream API key from the vault's stored credentials so the
  // operator doesn't retype a key they already saved. Matches the preset's
  // provider; leaves the field blank (manual entry) when no key is stored.
  const [storedCreds, setStoredCreds] = useState<Array<{ id: string; provider: string; name: string }>>([])

  useEffect(() => {
    if (!masterPassword) return
    void (async () => {
      try {
        const creds = await invoke<Array<{ id: string; provider: string; name: string }>>('get_credentials', {
          masterPassword,
        })
        setStoredCreds(creds)
      } catch {
        /* locked / no creds — leave manual entry */
      }
    })()
  }, [masterPassword])

  // Load the operator's own crypto wallets to offer as withdrawal destinations,
  // so "提现到钱包" is one tap (pick a wallet) instead of pasting an address.
  useEffect(() => {
    if (!masterPassword) return
    void (async () => {
      try {
        const wallets = await invoke<Array<{ name: string; accounts?: Array<{ address: string; chain: string }> }>>(
          'get_crypto_wallets',
          { masterPassword }
        )
        const options: PayoutOption[] = []
        const seen = new Set<string>()
        for (const wallet of wallets) {
          for (const account of wallet.accounts ?? []) {
            // EVM addresses only — the treasury USDC lives on an EVM chain.
            if (!/^0x[0-9a-fA-F]{40}$/.test(account.address) || seen.has(account.address.toLowerCase())) continue
            seen.add(account.address.toLowerCase())
            options.push({ address: account.address, label: `${wallet.name} · ${account.chain} · ${account.address.slice(0, 6)}…${account.address.slice(-4)}` })
          }
        }
        setPayoutOptions(options)
        setPayoutAddress((current) => current || options[0]?.address || '')
      } catch {
        /* locked / no wallets — operator can paste an address manually */
      }
    })()
  }, [masterPassword])

  const autoFillProviderToken = useCallback(
    async (provider: string) => {
      const match = findStoredCredentialForComputeProvider(storedCreds, provider)
      if (!match) return
      try {
        const key = await invoke<string | null>('get_credential_secret', {
          credentialId: match.id,
          masterPassword,
        })
        if (key) setProviderToken(key)
      } catch {
        /* leave manual entry */
      }
    },
    [storedCreds, masterPassword]
  )

  useEffect(() => {
    void autoFillProviderToken(selectedPreset.provider)
  }, [autoFillProviderToken, selectedPreset.provider])

  useEffect(() => {
    if (!configuredProvider) return
    setProviderLabel(`${configuredProvider.label || selectedPreset.label} shared token`)
    if (configuredProvider.api_key.trim()) setProviderToken(configuredProvider.api_key)
    const nextModel = providerModelOptions.length > 1 ? ALL_PROVIDER_MODELS : providerModelOptions[0] || selectedPreset.defaultModel
    setProviderModel(nextModel)
  }, [configuredProvider, providerModelOptions, selectedPreset.defaultModel, selectedPreset.label])

  function updatePreset(presetId: string) {
    const preset = COMPUTE_GATEWAY_PROVIDER_PRESETS.find((item) => item.id === presetId) ?? COMPUTE_GATEWAY_PROVIDER_PRESETS[0]
    setProviderPresetId(preset.id)
    setProviderModel(preset.defaultModel)
    setProviderLabel(`${preset.label} shared token`)
    setProviderToken('')
  }

  async function setupProviderChannel(gatewayUrl: string): Promise<string | null> {
    const rawToken = providerToken.trim()
    if (!rawToken) return null
    const selectedModels =
      providerModel === ALL_PROVIDER_MODELS
        ? providerModelOptions
        : [providerModel.trim() || providerModelOptions[0] || selectedPreset.defaultModel]
    const providerPayload = buildProviderTokenSetupPayload({
      presetId: providerPresetId,
      apiToken: rawToken,
      label: providerLabel,
      model: selectedModels[0],
      models: selectedModels,
      baseUrl: configuredProvider?.base_url.trim() || undefined,
    })
    const channel = await operatorPost<CreatedChannel>(gatewayUrl, masterPassword, '/operator/provider-tokens', providerPayload)
    for (const model of providerPayload.models) {
      await operatorPost(gatewayUrl, masterPassword, '/operator/price-book', buildDefaultComputeGatewayPricePayload(providerPayload.provider, model))
      await operatorPost(
        gatewayUrl,
        masterPassword,
        '/operator/routing-rules',
        buildDefaultComputeGatewayRoutingPayload({
          requestedModel: model,
          providerTokenId: channel.id,
          provider: providerPayload.provider,
        })
      )
    }
    setProviderToken('')
    return providerPayload.models.length > 1
      ? `${providerPayload.label} / ${providerPayload.models.length} 个模型`
      : `${providerPayload.label} / ${providerPayload.models[0]}`
  }

  async function completeFirstRunSetup() {
    setError('')
    setSetupNote('')
    if (!masterPassword) { setError('请先解锁应用'); return }
    const normalized = normalizeComputeGatewayUrl(url)
    if (!normalized) { setError('请填写网关地址'); return }
    setSetupSaving(true)
    try {
      // Register/login this operator (local key), then add the shared channel.
      await invoke('compute_gateway_operator_connect', { gatewayUrl: normalized, masterPassword })
      localStorage.setItem(LS_URL, normalized)
      setUrl(normalized)
      const channelLabel = await setupProviderChannel(normalized)
      setSetupNote(channelLabel ? `已连接公共网关，并添加共享渠道：${channelLabel}` : '已连接公共网关，可稍后添加共享渠道。')
      await refresh(normalized)
    } catch (e) {
      setError(String(e))
    } finally {
      setSetupSaving(false)
    }
  }

  // Models a friend can actually call = an active routing rule backed by an
  // active channel. The chosen model decides which account_group we create the
  // friend in, so the existing routing rules grant them exactly that model.
  const activeChannelIds = new Set(channels.filter((c) => c.status === 'active').map((c) => c.id))
  const modelOptions = Array.from(
    new Map(
      routingRules
        .filter((r) => r.status === 'active' && activeChannelIds.has(r.provider_token_id))
        .map((r) => [r.requested_model, { model: r.requested_model, group: r.account_group, provider: r.requested_provider }])
    ).values()
  )
  const selectedInviteModels = friendModels.filter((model) => modelOptions.some((option) => option.model === model))

  useEffect(() => {
    if (friendModels.length > 0 || modelOptions.length === 0) return
    setFriendModels([modelOptions[0].model])
  }, [friendModels.length, modelOptions])

  function toggleFriendModel(model: string) {
    setFriendModels((previous) =>
      previous.includes(model) ? previous.filter((item) => item !== model) : [...previous, model]
    )
  }

  // One link to onboard a friend: create their account in the model's group,
  // mint a one-time invite (auto-login), and optionally attach a red packet
  // (balance). The combined /accept link does login + claim in one open.
  async function inviteFriend() {
    setError(''); setInviteLink(''); setInviteNote('')
    // No name required — auto-label so inviting a friend is one click (just pick
    // a model + amount). The operator can still rename the account later.
    const name = friendName.trim() || `朋友 ${accounts.length + 1}`
    const chosenModels = modelOptions.filter((m) => selectedInviteModels.includes(m.model))
    const chosen = chosenModels[0]
    if (!chosen || chosenModels.length === 0) { setError('没有可用模型：先选择至少一个已共享的模型'); return }
    setInviting(true)
    try {
      const modelAllowlist = chosenModels.map((item) => item.model)
      const acct = await operatorPost<{ id: string }>(url, masterPassword, '/operator/accounts', {
        display_name: name,
        account_group: chosen.group,
        default_provider: chosen.provider,
        default_model: chosen.model,
        model_allowlist: modelAllowlist,
      })
      const inv = await operatorPost<{ invite_id: string; invite_token: string; invite_url?: string }>(url, masterPassword, `/operator/accounts/${acct.id}/invites`, {})
      const amount = Number(friendRp)
      // 邀请即充值：直接给账户记初始额度（不再发 MYC 红包）。$X → µUSD。
      if (Number.isFinite(amount) && amount > 0) {
        await operatorPost<{ balance_micro_usd: number }>(url, masterPassword, `/operator/accounts/${acct.id}/manual-credit`, {
          amount_micro_usd: Math.round(amount * 1_000_000),
        })
      }
      const base = url.replace(/\/+$/, '')
      const link = inv.invite_url || `${base}/accept?token=${encodeURIComponent(inv.invite_token)}&autocreate_key=1&tab=keys`
      const nextInviteLinks = { ...inviteLinksById, [inv.invite_id]: link }
      setInviteLinksById(nextInviteLinks)
      writeInviteLinks(nextInviteLinks)
      setInviteLink(link)
      setInviteNote(`已建账户「${name}」· 模型 ${modelAllowlist.join(', ')}${amount > 0 ? ` · 初始额度 $${amount}` : '（无额度）'}`)
      setFriendName('')
      await refresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setInviting(false)
    }
  }

  // Pull this operator's collected USDC out of the shared relayer to their own
  // wallet. The gateway caps the amount at this operator's withdrawable share.
  async function withdrawTreasury() {
    if (!revenue) return
    const to = payoutAddress.trim()
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) { setError('请填写有效的钱包地址（0x… 40位）'); return }
    const withdrawable = revenue.treasury.withdrawable_micro_usd
    if (withdrawable <= 0) { setError('暂无可提现余额'); return }
    if (!window.confirm(`将把 ${usd(withdrawable)} USDC 提现到\n${to}\n确定？`)) return
    setWithdrawing(true); setError(''); setWithdrawNote('')
    try {
      const res = await operatorPost<{ tx_hash: string; withdrawn_micro_usd: number }>(
        url, masterPassword, '/operator/treasury/withdraw', { to_address: to }
      )
      setWithdrawNote(`已提现 ${usd(res.withdrawn_micro_usd)} · tx ${res.tx_hash.slice(0, 10)}…`)
      await refresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setWithdrawing(false)
    }
  }

  async function updateAccountModels(account: Account) {
    const chosenModels = modelOptions.filter((m) => selectedInviteModels.includes(m.model))
    const chosen = chosenModels[0]
    if (!chosen || chosenModels.length === 0) { setError('请先选择至少一个模型'); return }
    setUpdatingAccountId(account.id)
    setError('')
    try {
      await operatorPatch(url, masterPassword, `/operator/accounts/${account.id}`, {
        display_name: account.display_name,
        default_model: chosen.model,
        model_allowlist: chosenModels.map((item) => item.model),
      })
      await refresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setUpdatingAccountId('')
    }
  }

  async function revokeInvite(invite: OperatorInvite) {
    // 取消 = 彻底断开该朋友：停用账户，其 API Key 与网页访问立即失效（不只是作废链接）。
    if (!window.confirm(`取消「${invite.account_display_name}」后，TA 的 API Key 和网页访问会立即失效（账户被停用）。确定？`)) return
    setRevokingInviteId(invite.id)
    setError('')
    try {
      await operatorPost(url, masterPassword, `/operator/invites/${invite.id}/revoke`, {})
      await refresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setRevokingInviteId('')
    }
  }

  // First-run setup until the operator is connected with at least one channel.
  const showFirstRunSetup = !connected && !connecting && channels.length === 0
  const statusLabel = connecting ? '连接中…' : connected ? url : '未连接'
  const modelControl =
    providerModelOptions.length > 0 ? (
      <select value={providerModel} onChange={(e) => setProviderModel(e.target.value)}>
        {providerModelOptions.length > 1 && (
          <option value={ALL_PROVIDER_MODELS}>全部配置模型 ({providerModelOptions.length})</option>
        )}
        {providerModelOptions.map((model) => (
          <option key={model} value={model}>{model}</option>
        ))}
      </select>
    ) : (
      <input value={providerModel} onChange={(e) => setProviderModel(e.target.value)} placeholder="模型 ID" />
    )

  return (
    <section className="compute-gateway-manager">
      <header className="compute-gateway-manager__header">
        <div><span>Compute Gateway</span><h2>运营控制台</h2></div>
        <code>{statusLabel}</code>
      </header>

      {showFirstRunSetup ? (
        <section className="compute-gateway-manager__setup">
          <div className="compute-gateway-manager__setup-main">
            <p className="compute-gateway-manager__eyebrow">首次设置</p>
            <h3>连接公共算力网关</h3>
            <p>朋友不需要部署 Cloudflare，也看不到你的上游密钥。你的运营者身份由本机自动生成的密钥保证——无需 Admin Token、无需邀请码。</p>
          </div>

          <div className="compute-gateway-manager__steps">
            <div className="compute-gateway-manager__step">
              <span>1</span>
              <label>
                网关地址
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={DEFAULT_PUBLIC_COMPUTE_GATEWAY_URL} />
              </label>
            </div>

            <div className="compute-gateway-manager__step">
              <span>2</span>
              <div>
                <strong>共享 AI Token</strong>
                <div className="compute-gateway-manager__channel-form">
                  <select value={providerPresetId} onChange={(e) => updatePreset(e.target.value)}>
                    {COMPUTE_GATEWAY_PROVIDER_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>{preset.label}</option>
                    ))}
                  </select>
                  {modelControl}
                  <input value={providerLabel} onChange={(e) => setProviderLabel(e.target.value)} placeholder="渠道名称" />
                  <input value={providerToken} onChange={(e) => setProviderToken(e.target.value)} placeholder={`${selectedPreset.label} 上游 API Key`} type="password" />
                </div>
              </div>
            </div>

            <div className="compute-gateway-manager__step">
              <span>3</span>
              <div className="compute-gateway-manager__finish-row">
                <button onClick={completeFirstRunSetup} disabled={setupSaving || !masterPassword}>
                  {setupSaving ? '连接中…' : '连接并共享'}
                </button>
                <p>身份与会话保存在本机；可继续添加百炼、Kimi 或其他 OpenAI-compatible 上游渠道。</p>
              </div>
            </div>
          </div>
          {setupNote && <p className="compute-gateway-manager__ok">{setupNote}</p>}
          {error && <p className="compute-gateway-manager__error">{error}</p>}
        </section>
      ) : (
        <section className="compute-gateway-manager__panel">
          <h3>连接</h3>
          <div className="compute-gateway-manager__connect-row">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="网关 URL" />
            <button onClick={connect} disabled={connecting || !masterPassword}>
              {connecting ? '连接中…' : '连接 / 刷新'}
            </button>
          </div>
          <p className="compute-gateway-manager__source">运营者身份：本机密钥（自动注册，无需 Admin Token）</p>
          {error && <p className="compute-gateway-manager__error">{error}</p>}
        </section>
      )}

      {connected && (
        <>
          <section className="compute-gateway-manager__panel compute-gateway-manager__revenue">
            <h3>💰 收入</h3>
            <div className="compute-gateway-manager__revenue-grid">
              <div className="compute-gateway-manager__revenue-card">
                <span className="compute-gateway-manager__revenue-label">Treasury USDC（可提现）</span>
                <strong className="compute-gateway-manager__revenue-value">{usd(revenue?.treasury.withdrawable_micro_usd ?? 0)}</strong>
                <span className="compute-gateway-manager__muted">
                  累计收 {usd(revenue?.treasury.credited_micro_usd ?? 0)} · 已提 {usd(revenue?.treasury.withdrawn_micro_usd ?? 0)}
                </span>
              </div>
              <div className="compute-gateway-manager__revenue-card">
                <span className="compute-gateway-manager__revenue-label">算力转售利润（账面）</span>
                <strong className="compute-gateway-manager__revenue-value">{usd(revenue?.margin.margin_micro_usd ?? 0)}</strong>
                <span className="compute-gateway-manager__muted">
                  {(revenue?.margin.calls ?? 0)} 次调用 · {(revenue?.margin.total_tokens ?? 0).toLocaleString()} tokens
                </span>
              </div>
            </div>
            <div className="compute-gateway-manager__withdraw-row">
              {payoutOptions.length > 0 && (
                <select value={payoutAddress} onChange={(e) => setPayoutAddress(e.target.value)}>
                  {payoutOptions.map((option) => (
                    <option key={option.address} value={option.address}>{option.label}</option>
                  ))}
                </select>
              )}
              <input value={payoutAddress} onChange={(e) => setPayoutAddress(e.target.value)} placeholder="提现到钱包地址 0x…" />
              <button onClick={withdrawTreasury} disabled={withdrawing || !revenue || revenue.treasury.withdrawable_micro_usd <= 0}>
                {withdrawing ? '提现中…' : '提现到钱包'}
              </button>
            </div>
            {withdrawNote && <p className="compute-gateway-manager__ok">✓ {withdrawNote}</p>}
            <p className="compute-gateway-manager__muted" style={{ marginTop: 8, fontSize: 12 }}>
              Treasury 是朋友买 MYC 付的 USDC，存在网关共享 relayer，只能提现你名下的份额。账面利润是 Σ(售价−上游成本)，随调用累计，不可直接提现。
            </p>
          </section>

          <section className="compute-gateway-manager__panel">
            <h3>共享 AI Token</h3>
            <div className="compute-gateway-manager__channel-form">
              <select value={providerPresetId} onChange={(e) => updatePreset(e.target.value)}>
                {COMPUTE_GATEWAY_PROVIDER_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.label}</option>
                ))}
              </select>
              {modelControl}
              <input value={providerLabel} onChange={(e) => setProviderLabel(e.target.value)} placeholder="渠道名称" />
              <input value={providerToken} onChange={(e) => setProviderToken(e.target.value)} placeholder={`${selectedPreset.label} 上游 API Key`} type="password" />
              <button
                onClick={async () => {
                  try {
                    setError('')
                    const label = await setupProviderChannel(normalizeComputeGatewayUrl(url))
                    setSetupNote(label ? `已添加共享渠道：${label}` : '未填写上游 AI Key')
                    await refresh(normalizeComputeGatewayUrl(url))
                  } catch (e) { setError(String(e)) }
                }}
              >
                添加渠道
              </button>
            </div>
            {setupNote && <p className="compute-gateway-manager__ok">{setupNote}</p>}
          </section>

          <section className="compute-gateway-manager__panel">
            <h3>👥 邀请朋友用模型</h3>
            <div className="compute-gateway-manager__invite-controls">
              <div className="compute-gateway-manager__model-checks">
                {modelOptions.length === 0 && <span className="compute-gateway-manager__muted">无可用模型</span>}
                {modelOptions.map((m) => (
                  <label key={m.model}>
                    <input
                      type="checkbox"
                      checked={selectedInviteModels.includes(m.model)}
                      onChange={() => toggleFriendModel(m.model)}
                    />
                    <span>{m.model}</span>
                  </label>
                ))}
              </div>
              <input value={friendRp} onChange={(e) => setFriendRp(e.target.value)} type="number" style={{ width: 110 }} />
              <span>初始额度 $（0 = 不送）</span>
              <button onClick={inviteFriend} disabled={inviting || modelOptions.length === 0}>{inviting ? '生成中…' : '生成邀请链接'}</button>
            </div>
            {inviteNote && <p style={{ marginTop: 8, color: '#228e42' }}>✓ {inviteNote}</p>}
            {inviteLink && (
              <p style={{ marginTop: 8 }}>
                <code style={{ wordBreak: 'break-all' }}>{inviteLink}</code>{' '}
                <button onClick={() => navigator.clipboard?.writeText(inviteLink)}>复制</button>
              </p>
            )}
            <p style={{ marginTop: 8, fontSize: 12, color: '#667' }}>
              直接从已共享渠道里多选模型；对方点开链接即自动登录，只能看到并使用你授权的模型。后续可在账户表应用当前选择修改授权。
            </p>
          </section>

          <section className="compute-gateway-manager__panel">
            <h3>分享链接 ({invites.length})</h3>
            <p className="compute-gateway-manager__muted" style={{ marginTop: -4, marginBottom: 10, fontSize: 12 }}>
              「取消」会停用该朋友的账户：TA 的 API Key 和网页访问都会立即失效，不只是作废链接。
            </p>
            <table><thead><tr><th>账户</th><th>状态</th><th>过期时间</th><th>链接</th><th>操作</th></tr></thead>
              <tbody>
                {invites.length === 0 && <tr><td colSpan={5}>还没有生成分享链接</td></tr>}
                {invites.map((invite) => {
                  const link = inviteLinksById[invite.id]
                  const active = invite.status === 'active'
                  return (
                    <tr key={invite.id}>
                      <td>{invite.account_display_name}</td>
                      <td>{invite.status}</td>
                      <td>{new Date(invite.expires_at).toLocaleString()}</td>
                      <td>
                        {link ? (
                          <code className="compute-gateway-manager__invite-link">{link}</code>
                        ) : (
                          <span className="compute-gateway-manager__muted">此设备没有保存完整链接</span>
                        )}
                      </td>
                      <td>
                        <div className="compute-gateway-manager__row-actions">
                          <button disabled={!link} onClick={() => link && window.open(link, '_blank', 'noopener,noreferrer')}>查看</button>
                          <button disabled={!link} onClick={() => link && navigator.clipboard?.writeText(link)}>复制</button>
                          <button disabled={!active || revokingInviteId === invite.id} onClick={() => revokeInvite(invite)}>
                            {revokingInviteId === invite.id ? '取消中…' : '取消'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>

          <div className="compute-gateway-manager__grid">
            <section className="compute-gateway-manager__panel">
              <h3>账户 ({accounts.length})</h3>
              <table><thead><tr><th>名称</th><th>授权模型</th><th>状态</th><th>余额</th><th>操作</th></tr></thead>
                <tbody>{accounts.map((a) => <tr key={a.id}>
                  <td>{a.display_name}</td>
                  <td>{(a.model_allowlist && a.model_allowlist.length > 0 ? a.model_allowlist : [a.default_model || '全部组模型']).join(', ')}</td>
                  <td>{a.status}</td>
                  <td>{usd(a.balance_micro_usd)}</td>
                  <td><button onClick={() => updateAccountModels(a)} disabled={updatingAccountId === a.id || selectedInviteModels.length === 0}>{updatingAccountId === a.id ? '更新中…' : '应用当前选择'}</button></td>
                </tr>)}</tbody>
              </table>
            </section>
            <section className="compute-gateway-manager__panel">
              <h3>渠道 ({channels.length})</h3>
              <table><thead><tr><th>Label</th><th>Provider</th><th>状态</th></tr></thead>
                <tbody>{channels.map((c) => <tr key={c.id}><td>{c.label}</td><td>{c.provider}</td><td>{c.status}</td></tr>)}</tbody>
              </table>
            </section>
          </div>
        </>
      )}
    </section>
  )
}

export default ComputeGatewayManager

import { useEffect, useState } from 'react'
import { formatMicroUsd } from '../dashboardViewModel.js'
import { redeemGasless, loadOnchainConfig, buyMyc, faucetUsdt, type OnchainConfig } from '../api.js'
import { Button, Card, CardContent, PanelTitle } from '../token-ui.js'
import {
  connectWallet,
  loadStoredWallet,
  getMycBalance,
  getStablecoinBalance,
  signBurnAuth,
  signStablecoinTransferAuth,
  prfSupported,
} from '../wallet.js'

const MYC_NOTE = '1 MYC = $1 算力（≈ 67 万 tokens）· 全程免 gas'

export function Topup({
  balanceMicroUsd,
  accountId,
  connected,
  onConnectChange,
  onRefresh,
}: {
  balanceMicroUsd: number
  accountId: string
  connected: boolean
  onConnectChange: (v: boolean) => void
  onRefresh?: () => void | Promise<void>
}) {
  const [address, setAddress] = useState<string | null>(() => (connected ? loadStoredWallet()?.address ?? null : null))
  const [mycBalance, setMycBalance] = useState<bigint | null>(null)
  const [usdtBalance, setUsdtBalance] = useState<bigint | null>(null)
  const [config, setConfig] = useState<OnchainConfig | null>(null)
  const [amount, setAmount] = useState('10')
  const [usdtAmount, setUsdtAmount] = useState('10')
  const [busy, setBusy] = useState<null | string>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [creditBalance, setCreditBalance] = useState(balanceMicroUsd)

  async function refreshBalance(addr: string) {
    try { setMycBalance(await getMycBalance(addr)) } catch { setMycBalance(null) }
  }
  async function refreshUsdt(addr: string, cfg: OnchainConfig | null) {
    if (!cfg?.stablecoin_token) { setUsdtBalance(null); return }
    try { setUsdtBalance(await getStablecoinBalance(cfg.stablecoin_token, addr)) } catch { setUsdtBalance(null) }
  }
  useEffect(() => { if (address) refreshBalance(address) }, [address])
  // Keep the displayed credit in sync with the live snapshot — otherwise it goes
  // stale after a chat (which spends credit) or a top-up done elsewhere.
  useEffect(() => { setCreditBalance(balanceMicroUsd) }, [balanceMicroUsd])
  useEffect(() => {
    loadOnchainConfig().then((cfg) => { setConfig(cfg); if (address) refreshUsdt(address, cfg) }).catch(() => setConfig(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])
  // Reflect connect/disconnect driven from the header wallet button.
  useEffect(() => { setAddress(connected ? loadStoredWallet()?.address ?? null : null) }, [connected])

  async function onConnect() {
    setMsg(null)
    if (!prfSupported()) { setMsg({ ok: false, text: '当前浏览器不支持 passkey（需 Chrome/Safari + 生物识别）' }); return }
    setBusy('连接 passkey 钱包…（Touch ID 确认）')
    try {
      const w = await connectWallet(accountId)
      setAddress(w.address)
      onConnectChange(true)
    } catch (e) { setMsg({ ok: false, text: humanError(e) }) } finally { setBusy(null) }
  }


  async function onRedeem() {
    setMsg(null)
    const myc = Number(amount)
    if (!Number.isFinite(myc) || myc <= 0) { setMsg({ ok: false, text: '请输入有效的 MYC 数量' }); return }
    const raw = BigInt(Math.round(myc * 1e6))
    if (mycBalance != null && raw > mycBalance) { setMsg({ ok: false, text: 'MYC 余额不足' }); return }
    try {
      setBusy('签名授权…（Touch ID，免 gas）')
      const auth = await signBurnAuth(accountId, raw)
      setBusy('网关中继上链 + 充值中…')
      const result = await redeemGasless(auth as unknown as Record<string, string>)
      setCreditBalance(result.balance_micro_usd)
      if (address) refreshBalance(address)
      void onRefresh?.()
      setMsg({ ok: true, text: `✓ 已兑换 ${formatMicroUsd(result.credited_micro_usd)} 额度（烧 ${result.burned_myc} MYC）` })
    } catch (e) { setMsg({ ok: false, text: humanError(e) }) } finally { setBusy(null) }
  }

  // Get test USDT into the wallet so the buy flow can run on testnet.
  async function onFaucet() {
    setMsg(null)
    if (!address) { setMsg({ ok: false, text: '请先创建钱包' }); return }
    setBusy('领取测试 USDT…')
    try {
      const r = await faucetUsdt(address)
      await refreshUsdt(address, config)
      setMsg({ ok: true, text: `✓ 领到 ${r.minted_usdt} 测试 USDT` })
    } catch (e) { setMsg({ ok: false, text: humanError(e) }) } finally { setBusy(null) }
  }

  // 用 USDT 充值额度：第 1 次签名确认充值 USDT；
  // 第 2 次签名确认兑换对话算力代币。两次 Touch ID，全程免 gas。
  async function onBuyWithUsdt() {
    setMsg(null)
    if (!address) { setMsg({ ok: false, text: '请先创建钱包' }); return }
    if (!config?.stablecoin_token || !config.relayer_address) { setMsg({ ok: false, text: '网关未配置 USDT 充值' }); return }
    const usdt = Number(usdtAmount)
    if (!Number.isFinite(usdt) || usdt <= 0) { setMsg({ ok: false, text: '请输入有效的 USDT 数量' }); return }
    const raw = BigInt(Math.round(usdt * 1e6))
    if (usdtBalance != null && raw > usdtBalance) { setMsg({ ok: false, text: 'USDT 余额不足' }); return }
    try {
      setBusy('充值 USDT：等待签名确认（Touch ID，免 gas）')
      const payAuth = await signStablecoinTransferAuth(config.stablecoin_token, config.relayer_address, raw)
      setBusy('充值 USDT 上链中…')
      const bought = await buyMyc(payAuth as unknown as Record<string, string>)
      // 把刚买到的 MYC 烧成额度。
      setBusy('签名兑换对话算力代币（Touch ID，免 gas）')
      const burnRaw = BigInt(Math.round(bought.bought_myc * 1e6))
      const burnAuth = await signBurnAuth(accountId, burnRaw)
      setBusy('对话算力代币兑换额度中…')
      const result = await redeemGasless(burnAuth as unknown as Record<string, string>)
      setCreditBalance(result.balance_micro_usd)
      await refreshBalance(address)
      await refreshUsdt(address, config)
      void onRefresh?.()
      setMsg({ ok: true, text: `✓ 用 ${bought.paid_usdt} USDT 充值了 ${formatMicroUsd(result.credited_micro_usd)} 对话算力额度` })
    } catch (e) { setMsg({ ok: false, text: humanError(e) }) } finally { setBusy(null) }
  }

  const usdtConfigured = !!config?.stablecoin_token

  return (
    <Card>
      <PanelTitle eyebrow={MYC_NOTE} title="充值额度" />
      <CardContent className="split">
        <div>
          <span className="muted">AI 额度余额</span>
          <strong className="balance">{formatMicroUsd(creditBalance)}</strong>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {!connected || !address ? (
            <div>
              <div className="muted" style={{ marginBottom: 6 }}>{loadStoredWallet() ? '钱包已退出' : '连接钱包'}</div>
              <p style={{ marginBottom: 10 }}>
                {loadStoredWallet()
                  ? '钱包已断开。连接后即可领红包、买额度（资产仍在，连接安全恢复）。'
                  : '用 passkey 连接钱包：同一个 passkey 在任意设备都恢复同一个钱包（免助记词、免 gas，Touch ID 即用）。'}
              </p>
              <Button onClick={onConnect} disabled={!!busy}>连接钱包</Button>
            </div>
          ) : (
            <>
              <div>
                <div className="muted" style={{ marginBottom: 6 }}>我的钱包</div>
                <code style={{ wordBreak: 'break-all' }}>{address}</code>
                {usdtConfigured && (
                  <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>
                    USDT 余额：<strong>{usdtBalance == null ? '…' : (Number(usdtBalance) / 1e6).toLocaleString()} USDT</strong>
                  </p>
                )}
              </div>

              {usdtConfigured && (
                <div>
                  <div className="muted" style={{ marginBottom: 6 }}>💵 用 USDT 充值额度（免 gas）</div>
                  <p className="muted" style={{ marginBottom: 8, fontSize: 13 }}>
                    额度用完了？两次 Touch ID：先签名充值 USDT；随后签名兑换对话算力代币，完成 AI 对话额度充值。
                  </p>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input type="number" value={usdtAmount} onChange={(e) => setUsdtAmount(e.target.value)} min="1"
                      style={{ width: 110, height: 40, padding: '0 12px', background: 'var(--panel-alt)', border: '1px solid var(--border)', borderRadius: 12, fontFamily: 'var(--mono)' }} />
                    <span className="muted">USDT → ${Number(usdtAmount) || 0} 额度</span>
                    <Button onClick={onBuyWithUsdt} disabled={!!busy}>用 USDT 充值</Button>
                    {config?.faucet_enabled && (
                      <button onClick={onFaucet} disabled={!!busy}
                        style={{ height: 40, padding: '0 12px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--muted)', borderRadius: 12, cursor: 'pointer', fontSize: 13 }}>
                        领 10 测试 USDT
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Only when you actually hold MYC (e.g. from a red packet). The USDT
                  top-up above already buys + burns MYC internally, so a USDT user
                  always has 0 MYC and shouldn't see a confusing always-zero section. */}
              {mycBalance != null && mycBalance > 0n && (
                <div>
                  <div className="muted" style={{ marginBottom: 6 }}>兑换持有的 MYC（免 gas）</div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} min="1"
                      style={{ width: 110, height: 40, padding: '0 12px', background: 'var(--panel-alt)', border: '1px solid var(--border)', borderRadius: 12, fontFamily: 'var(--mono)' }} />
                    <span className="muted">MYC → ${Number(amount) || 0} 额度</span>
                    <Button onClick={onRedeem} disabled={!!busy}>兑换</Button>
                  </div>
                </div>
              )}
            </>
          )}
          {busy && <p className="topup-busy">{busy}</p>}
          {msg && <p style={{ color: msg.ok ? 'var(--status-healthy, #228e42)' : 'var(--status-critical, #c40918)' }}>{msg.text}</p>}
        </div>
      </CardContent>
    </Card>
  )
}

function humanError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  const map: Record<string, string> = {
    prf_unsupported: '这个 passkey 不支持 PRF（换个浏览器/设备）',
    no_wallet: '还没创建钱包',
    passkey_create_cancelled: '已取消创建',
    passkey_get_cancelled: '已取消签名',
    redpacket_not_found: '红包口令无效',
    redpacket_already_claimed: '这个红包已经被领过了',
    relayer_pool_insufficient: '红包池余额不足，联系运营方',
    topup_already_credited: '这笔已经兑换过了',
    no_burn_in_tx: '链上没找到销毁记录',
    stablecoin_not_configured: '网关还没配置 USDT 充值',
    relayer_not_configured: '网关中继未配置',
    faucet_disabled: '主网不提供测试 USDT 领取',
    faucet_already_claimed: '测试 USDT 每个账户只能领取一次',
    invalid_value: '金额无效',
    invalid_address: '钱包地址无效',
  }
  return map[m] ?? m
}

import { useEffect, useState } from 'react'
import { formatMicroUsd } from '../dashboardViewModel.js'
import { claimRedpacket, redeemGasless } from '../api.js'
import { Button, Card, CardContent, PanelTitle } from '../token-ui.js'
import { createWallet, loadStoredWallet, getMycBalance, signBurnAuth, prfSupported } from '../wallet.js'

const MYC_NOTE = '1 MYC = $1 算力（≈ 67 万 tokens）· 全程免 gas'

function urlRedpacketCode(): string {
  return new URLSearchParams(window.location.search).get('redpacket') ?? ''
}

export function Topup({ balanceMicroUsd, accountId }: { balanceMicroUsd: number; accountId: string }) {
  const [address, setAddress] = useState<string | null>(() => loadStoredWallet()?.address ?? null)
  const [mycBalance, setMycBalance] = useState<bigint | null>(null)
  const [amount, setAmount] = useState('10')
  const [code, setCode] = useState(urlRedpacketCode)
  const [busy, setBusy] = useState<null | string>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [creditBalance, setCreditBalance] = useState(balanceMicroUsd)

  async function refreshBalance(addr: string) {
    try { setMycBalance(await getMycBalance(addr)) } catch { setMycBalance(null) }
  }
  useEffect(() => { if (address) refreshBalance(address) }, [address])

  async function onCreate() {
    setMsg(null)
    if (!prfSupported()) { setMsg({ ok: false, text: '当前浏览器不支持 passkey（需 Chrome/Safari + 生物识别）' }); return }
    setBusy('创建 passkey 钱包…（Touch ID 确认）')
    try {
      const w = await createWallet(accountId)
      setAddress(w.address)
    } catch (e) { setMsg({ ok: false, text: humanError(e) }) } finally { setBusy(null) }
  }

  async function onClaim() {
    setMsg(null)
    if (!address) { setMsg({ ok: false, text: '请先创建钱包' }); return }
    if (!code.trim()) { setMsg({ ok: false, text: '请输入红包口令' }); return }
    setBusy('领取红包中…')
    try {
      const r = await claimRedpacket(code.trim(), address)
      setCode('')
      await refreshBalance(address)
      setMsg({ ok: true, text: `🧧 领到 ${r.amount_myc} MYC！可以兑换额度了` })
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
      setMsg({ ok: true, text: `✓ 已兑换 ${formatMicroUsd(result.credited_micro_usd)} 额度（烧 ${result.burned_myc} MYC）` })
    } catch (e) { setMsg({ ok: false, text: humanError(e) }) } finally { setBusy(null) }
  }

  return (
    <Card>
      <PanelTitle eyebrow={MYC_NOTE} title="MYC 红包 · 兑换额度" />
      <CardContent className="split">
        <div>
          <span className="muted">AI 额度余额</span>
          <strong className="balance">{formatMicroUsd(creditBalance)}</strong>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {!address ? (
            <div>
              <div className="muted" style={{ marginBottom: 6 }}>第 1 步 · 创建钱包</div>
              <p style={{ marginBottom: 10 }}>用 passkey 创建钱包（无需助记词、无需 gas，Touch ID 即用）。</p>
              <Button onClick={onCreate} disabled={!!busy}>创建 passkey 钱包</Button>
            </div>
          ) : (
            <>
              <div>
                <div className="muted" style={{ marginBottom: 6 }}>我的钱包</div>
                <code style={{ wordBreak: 'break-all' }}>{address}</code>
                <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>
                  MYC 余额：<strong>{mycBalance == null ? '…' : (Number(mycBalance) / 1e6).toLocaleString()} MYC</strong>
                </p>
              </div>
              <div>
                <div className="muted" style={{ marginBottom: 6 }}>🧧 领取红包</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="输入红包口令"
                    style={{ flex: 1, height: 40, padding: '0 12px', background: 'var(--panel-alt)', border: '1px solid var(--border)', borderRadius: 12, fontFamily: 'var(--mono)', fontSize: 13 }} />
                  <Button onClick={onClaim} disabled={!!busy}>领取</Button>
                </div>
              </div>
              <div>
                <div className="muted" style={{ marginBottom: 6 }}>兑换额度（免 gas）</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} min="1"
                    style={{ width: 110, height: 40, padding: '0 12px', background: 'var(--panel-alt)', border: '1px solid var(--border)', borderRadius: 12, fontFamily: 'var(--mono)' }} />
                  <span className="muted">MYC → ${Number(amount) || 0} 额度</span>
                  <Button onClick={onRedeem} disabled={!!busy}>兑换</Button>
                </div>
              </div>
            </>
          )}
          {busy && <p className="muted" style={{ color: 'var(--accent)' }}>{busy}</p>}
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
  }
  return map[m] ?? m
}

import { useEffect, useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './ComputeGatewayManager.css'

const LS_URL = 'mykey_gateway_url'
const LS_TOKEN = 'mykey_gateway_admin_token'

interface Account { id: string; display_name: string; status: string; balance_micro_usd: number; account_group: string }
interface Channel { id: string; label: string; provider: string; status: string; base_url: string | null }
interface Redpacket { id: string; amount_myc: number; label: string | null; status: string; claimed_to_address: string | null; created_at: string }
interface Topup { account_id: string; burned_myc: number; credited_micro_usd: number; tx_hash: string; created_at: string }

function usd(micro: number) { return '$' + (micro / 1e6).toFixed(2) }

async function adminGet<T>(url: string, token: string, path: string): Promise<T> {
  const text = await invoke<string>('compute_gateway_admin_request', { gatewayUrl: url, adminToken: token, method: 'GET', path, body: null })
  return JSON.parse(text) as T
}
async function adminPost<T>(url: string, token: string, path: string, body: unknown): Promise<T> {
  const text = await invoke<string>('compute_gateway_admin_request', { gatewayUrl: url, adminToken: token, method: 'POST', path, body: JSON.stringify(body) })
  return JSON.parse(text) as T
}

export function ComputeGatewayManager() {
  const [url, setUrl] = useState(() => localStorage.getItem(LS_URL) ?? 'https://mykey-compute-gateway.v2eth.workers.dev')
  const [token, setToken] = useState(() => localStorage.getItem(LS_TOKEN) ?? '')
  const [connected, setConnected] = useState(false)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [redpackets, setRedpackets] = useState<Redpacket[]>([])
  const [topups, setTopups] = useState<Topup[]>([])
  const [rpAmount, setRpAmount] = useState('10')
  const [lastLink, setLastLink] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setError('')
    try {
      const [a, c, r, t] = await Promise.all([
        adminGet<{ data: Account[] }>(url, token, '/admin/accounts'),
        adminGet<{ data: Channel[] }>(url, token, '/admin/provider-tokens'),
        adminGet<{ data: Redpacket[] }>(url, token, '/admin/redpackets'),
        adminGet<{ data: Topup[] }>(url, token, '/admin/topups'),
      ])
      setAccounts(a.data); setChannels(c.data); setRedpackets(r.data); setTopups(t.data)
      setConnected(true)
    } catch (e) { setError(String(e)); setConnected(false) }
  }, [url, token])

  useEffect(() => { if (token) refresh() }, [refresh, token])

  function connect() {
    localStorage.setItem(LS_URL, url)
    localStorage.setItem(LS_TOKEN, token)
    refresh()
  }

  async function createRedpacket() {
    setError('')
    try {
      const r = await adminPost<{ claim_url: string }>(url, token, '/admin/redpackets', { amount_myc: Number(rpAmount), label: '原生发放' })
      setLastLink(r.claim_url)
      refresh()
    } catch (e) { setError(String(e)) }
  }

  return (
    <section className="compute-gateway-manager">
      <header className="compute-gateway-manager__header">
        <div><span>Compute Gateway</span><h2>运营控制台</h2></div>
        <code>{connected ? url : '未连接'}</code>
      </header>

      <section className="compute-gateway-manager__panel">
        <h3>连接</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="网关 URL" style={{ flex: '1 1 320px', minWidth: 240 }} />
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="ADMIN_TOKEN" type="password" style={{ flex: '1 1 240px' }} />
          <button onClick={connect}>连接 / 刷新</button>
        </div>
        {error && <p style={{ color: '#c40918', marginTop: 8 }}>✗ {error}</p>}
      </section>

      {connected && (
        <>
          <section className="compute-gateway-manager__panel">
            <h3>🧧 发红包</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input value={rpAmount} onChange={(e) => setRpAmount(e.target.value)} type="number" style={{ width: 100 }} />
              <span>MYC（= ${Number(rpAmount) || 0} 算力）</span>
              <button onClick={createRedpacket}>生成红包链接</button>
            </div>
            {lastLink && (
              <p style={{ marginTop: 8 }}>
                <code style={{ wordBreak: 'break-all' }}>{lastLink}</code>{' '}
                <button onClick={() => navigator.clipboard?.writeText(lastLink)}>复制</button>
              </p>
            )}
          </section>

          <div className="compute-gateway-manager__grid">
            <section className="compute-gateway-manager__panel">
              <h3>账户 ({accounts.length})</h3>
              <table><thead><tr><th>名称</th><th>组</th><th>状态</th><th>余额</th></tr></thead>
                <tbody>{accounts.map((a) => <tr key={a.id}><td>{a.display_name}</td><td>{a.account_group}</td><td>{a.status}</td><td>{usd(a.balance_micro_usd)}</td></tr>)}</tbody>
              </table>
            </section>
            <section className="compute-gateway-manager__panel">
              <h3>渠道 ({channels.length})</h3>
              <table><thead><tr><th>Label</th><th>Provider</th><th>状态</th></tr></thead>
                <tbody>{channels.map((c) => <tr key={c.id}><td>{c.label}</td><td>{c.provider}</td><td>{c.status}</td></tr>)}</tbody>
              </table>
            </section>
            <section className="compute-gateway-manager__panel compute-gateway-manager__panel--wide">
              <h3>红包记录 ({redpackets.length})</h3>
              <table><thead><tr><th>金额</th><th>状态</th><th>领取地址</th><th>时间</th></tr></thead>
                <tbody>{redpackets.map((r) => <tr key={r.id}><td>{r.amount_myc} MYC</td><td>{r.status}</td><td><code>{r.claimed_to_address ?? '—'}</code></td><td>{new Date(r.created_at).toLocaleString()}</td></tr>)}</tbody>
              </table>
            </section>
            <section className="compute-gateway-manager__panel compute-gateway-manager__panel--wide">
              <h3>兑换记录 ({topups.length})</h3>
              <table><thead><tr><th>账户</th><th>烧 MYC</th><th>到账额度</th><th>Tx</th></tr></thead>
                <tbody>{topups.map((t, i) => <tr key={i}><td><code>{t.account_id.slice(0, 18)}…</code></td><td>{t.burned_myc}</td><td>{usd(t.credited_micro_usd)}</td><td><code>{t.tx_hash.slice(0, 14)}…</code></td></tr>)}</tbody>
              </table>
            </section>
          </div>
        </>
      )}
    </section>
  )
}

export default ComputeGatewayManager

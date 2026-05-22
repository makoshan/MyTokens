import { useState } from 'react'
import { connectWallet, createWallet, disconnectWallet, loadStoredWallet, prfSupported } from '../wallet.js'

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

// Wallet login/logout chip for the dashboard header — visible on every tab.
// Logged-out: a connect button. Logged-in: the address + a disconnect button.
export function WalletButton({
  accountId,
  connected,
  onConnect,
  onDisconnect,
}: {
  accountId: string
  connected: boolean
  onConnect: () => void
  onDisconnect: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const wallet = loadStoredWallet()

  function humanErr(e: unknown): string {
    const m = e instanceof Error ? e.message : String(e)
    if (m === 'passkey_create_cancelled' || m === 'passkey_get_cancelled') return '已取消'
    if (m === 'prf_unsupported') return '此 passkey 不支持'
    return m
  }

  // Login = cached wallet, or restore the same wallet from the synced passkey.
  async function connect() {
    setErr('')
    if (!prfSupported()) {
      setErr('需 Chrome/Safari + 生物识别')
      return
    }
    setBusy(true)
    try {
      await connectWallet(accountId)
      onConnect()
    } catch (e) {
      setErr(humanErr(e))
    } finally {
      setBusy(false)
    }
  }

  // Brand-new wallet (no passkey yet) — explicit so we never create a duplicate.
  async function create() {
    setErr('')
    setBusy(true)
    try {
      await createWallet(accountId)
      onConnect()
    } catch (e) {
      setErr(humanErr(e))
    } finally {
      setBusy(false)
    }
  }

  if (connected && wallet) {
    return (
      <div className="wallet-chip wallet-chip--in" title={wallet.address}>
        <span className="wallet-dot" aria-hidden />
        <code>{shortAddr(wallet.address)}</code>
        <button
          type="button"
          onClick={() => {
            disconnectWallet()
            onDisconnect()
          }}
        >
          退出
        </button>
      </div>
    )
  }

  return (
    <div className="wallet-chip wallet-chip--out">
      <button type="button" onClick={connect} disabled={busy}>
        {busy ? '连接中…' : wallet ? '🔑 连接钱包' : '🔑 登录钱包'}
      </button>
      {/* No cached wallet: connect restores via the synced passkey; if the user
          has none yet, offer an explicit create so we never duplicate a passkey. */}
      {!wallet && (
        <button type="button" className="wallet-link" onClick={create} disabled={busy} title="还没有钱包？新建一个">
          新建
        </button>
      )}
      {err && <span className="wallet-err">{err}</span>}
    </div>
  )
}

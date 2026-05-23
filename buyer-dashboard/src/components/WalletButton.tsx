import { useState } from 'react'
import { connectWallet, loginWallet, logoutWallet, loadStoredWallet, prfSupported } from '../wallet.js'

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

  // Cross-device restore: pick an existing (synced) passkey to recover the same
  // wallet. Only for users who already created one elsewhere.
  async function login() {
    setErr('')
    setBusy(true)
    try {
      await loginWallet(accountId)
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
            logoutWallet()
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
        {busy ? '连接中…' : wallet ? '🔑 连接钱包' : '🔑 创建钱包'}
      </button>
      {/* No cached wallet: the primary button CREATES a new passkey wallet (the
          common first-time case). If you already have one on another device,
          restore it via discoverable login instead. */}
      {!wallet && (
        <button type="button" className="wallet-link" onClick={login} disabled={busy} title="在其他设备已创建过钱包？登录恢复">
          已有钱包？登录
        </button>
      )}
      {err && <span className="wallet-err">{err}</span>}
    </div>
  )
}

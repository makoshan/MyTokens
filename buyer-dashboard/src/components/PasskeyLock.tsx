import { useState } from 'react'
import { unlockWithPasskey, prfSupported } from '../wallet.js'

// Full-screen passkey gate shown after the user logs out (退出). Even though the
// gateway session cookie is still valid, the dashboard stays veiled until a fresh
// Touch ID assertion re-verifies the passkey — so "登录" actually means a passkey
// check, not a silent cookie auto-login.
export function PasskeyLock({ accountId, onUnlock }: { accountId: string; onUnlock: () => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function unlock() {
    setErr('')
    if (!prfSupported()) {
      setErr('当前浏览器不支持 passkey（需 Chrome / Safari + 生物识别）')
      return
    }
    setBusy(true)
    try {
      await unlockWithPasskey(accountId)
      onUnlock()
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      setErr(
        m === 'passkey_get_cancelled'
          ? '已取消'
          : m === 'prf_unsupported'
            ? '此 passkey 不支持'
            : m
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="pk-lock">
      <style>{PK_CSS}</style>
      <div className="pk-card">
        <div className="pk-icon" aria-hidden>🔒</div>
        <h2>用 Passkey 登录</h2>
        <p className="pk-sub">你已退出。用 Touch ID / 生物识别验证你的 passkey 才能进入。</p>
        <button type="button" className="pk-cta" onClick={unlock} disabled={busy}>
          {busy ? '验证中…' : '🔑 Touch ID 登录'}
        </button>
        {err && <p className="pk-err">✗ {err}</p>}
        <p className="pk-tip">同一个 passkey 会恢复同一个钱包（含余额），换设备也一样。</p>
      </div>
    </main>
  )
}

const PK_CSS = `
.pk-lock { min-height: 100vh; display: grid; place-items: center; padding: 24px;
  background: radial-gradient(120% 120% at 50% 0%, rgba(0,127,255,0.12), rgba(17,29,74,0.06)); }
.pk-card { width: 380px; max-width: calc(100% - 32px); background: #fff; border-radius: 24px; padding: 36px 28px;
  text-align: center; box-shadow: 0 30px 70px rgba(17,29,74,0.25); }
.pk-icon { font-size: 44px; line-height: 1; }
.pk-card h2 { font-size: 22px; font-weight: 800; margin: 14px 0 6px; color: var(--text, #111d4a); }
.pk-sub { font-size: 14px; color: var(--muted-strong, #475569); margin: 0 0 22px; }
.pk-cta { width: 100%; height: 48px; border-radius: 999px; border: 0; cursor: pointer; font-size: 16px; font-weight: 700;
  background: var(--primary, rgb(0 127 255)); color: var(--primary-foreground, rgb(255 255 255)); box-shadow: 0 12px 28px rgba(0,127,255,0.3); }
.pk-cta:disabled { background: var(--primary-active, rgb(0 82 165)); color: var(--primary-foreground, rgb(255 255 255)); cursor: default; }
.pk-err { color: var(--status-critical, #c40918); font-size: 14px; margin: 14px 0 0; }
.pk-tip { font-size: 12px; color: var(--muted, #667); margin: 16px 0 0; }
`

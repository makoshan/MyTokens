import { useState } from 'react'
import { claimWalletAction } from '../dashboardViewModel.js'
import { createWallet, isPasskeyLocked, loadStoredWallet, prfSupported, unlockWithPasskey } from '../wallet.js'
import { redpacketReward, humanError } from '../redpacketRewards.js'

type Stage = 'sealed' | 'opening' | 'revealed' | 'error'

// The friend's first-arrival "claim" experience for a manual-credit invite:
// open the gift → create a passkey wallet (Touch ID) → reveal the models they
// were granted + how much usage their balance buys. Mirrors RedpacketClaim, but
// for the no-token onboarding flow (and the wallet it creates is reused later for
// USDT top-ups).
export function WelcomeClaim({
  accountId,
  models,
  balanceMicroUsd,
  onClose,
}: {
  accountId: string
  models: string[]
  balanceMicroUsd: number
  onClose: () => void
}) {
  const [stage, setStage] = useState<Stage>('sealed')
  const [error, setError] = useState('')

  async function open() {
    setError('')
    if (!prfSupported()) {
      setError('当前浏览器不支持 passkey（需 Chrome / Safari + 生物识别）')
      setStage('error')
      return
    }
    setStage('opening')
    try {
      // 先创建 passkey 钱包（已有则复用）——之后充值 / 用 USDT 买额度都用它。
      const storedWallet = loadStoredWallet()
      const action = claimWalletAction({ hasStoredWallet: !!storedWallet, passkeyLocked: isPasskeyLocked() })
      if (action === 'unlock') await unlockWithPasskey(accountId)
      if (action === 'create') await createWallet(accountId)
      setStage('revealed')
    } catch (e) {
      setError(humanError(e))
      setStage('error')
    }
  }

  const usd = balanceMicroUsd / 1e6
  const { tokensWanLabel } = redpacketReward(usd)
  const hasModels = models.length > 0

  return (
    <div className="wc-overlay">
      <style>{WC_CSS}</style>
      <button className="wc-dismiss" onClick={onClose} aria-label="关闭">×</button>

      {(stage === 'sealed' || stage === 'opening') && (
        <div className={`wc-gift ${stage === 'opening' ? 'wc-opening' : ''}`} onClick={stage === 'sealed' ? open : undefined}>
          <div className="wc-lid" />
          <div className="wc-bow">🎁</div>
          <div className="wc-gift-body">
            <div className="wc-gift-title">朋友送你的 AI 算力</div>
            <div className="wc-gift-sub">{stage === 'opening' ? '正在创建你的钱包…（Touch ID 确认）' : '点击领取'}</div>
          </div>
        </div>
      )}

      {stage === 'revealed' && (
        <div className="wc-card wc-pop">
          <Confetti />
          <div className="wc-hooray">🎉 领取成功！</div>
          <div className="wc-quota">
            <span className="wc-quota-usd">${usd.toFixed(2)}</span>
            <span className="wc-quota-sub">≈ {tokensWanLabel} 万 tokens 用量</span>
          </div>
          <div className="wc-block">
            <div className="wc-block-title">可用模型</div>
            {hasModels ? (
              <div className="wc-models">
                {models.map((m) => (
                  <span key={m} className="wc-model-chip">{m}</span>
                ))}
              </div>
            ) : (
              <p className="wc-muted">运营者还没共享模型，稍后再来看看。</p>
            )}
          </div>
          <p className="wc-tip">已为你创建好钱包，余额用完可用 USDT 充值 · 全程免 gas</p>
          <button className="wc-cta" onClick={onClose}>开始对话 →</button>
        </div>
      )}

      {stage === 'error' && (
        <div className="wc-card">
          <div className="wc-err">✗ {error}</div>
          <button className="wc-cta" onClick={() => setStage('sealed')}>重试</button>
          <button className="wc-later" onClick={onClose}>稍后</button>
        </div>
      )}
    </div>
  )
}

function Confetti() {
  return (
    <div className="wc-confetti" aria-hidden>
      {Array.from({ length: 24 }).map((_, i) => (
        <span key={i} style={{ left: `${(i * 4.1) % 100}%`, animationDelay: `${(i % 8) * 0.12}s`, background: ['#007fff', '#0cc5ff', '#ffd23f', '#ff5e7a', '#34d399'][i % 5] }} />
      ))}
    </div>
  )
}

const WC_CSS = `
.wc-overlay { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center;
  background: radial-gradient(120% 120% at 50% 0%, rgba(0,127,255,0.2), rgba(17,29,74,0.6)); backdrop-filter: blur(6px); padding: 24px; }
.wc-dismiss { position: absolute; top: 18px; right: 20px; width: 40px; height: 40px; border-radius: 999px;
  background: rgba(255,255,255,0.85); color: var(--text); font-size: 22px; border: 0; cursor: pointer; }
.wc-gift { position: relative; width: 320px; height: 220px; border-radius: 20px; cursor: pointer;
  background: linear-gradient(160deg, #1f6fff, #0a3fb0); box-shadow: 0 24px 60px rgba(10,63,176,0.45);
  display: grid; place-items: center; transition: transform 0.2s; }
.wc-gift:hover { transform: translateY(-4px) scale(1.02); }
.wc-lid { position: absolute; top: 0; left: 0; right: 0; height: 70px; border-radius: 20px 20px 30% 30%;
  background: linear-gradient(160deg, #2f86ff, #1357d6); transform-origin: top; transition: transform 0.6s ease; z-index: 2; }
.wc-opening .wc-lid { transform: rotateX(150deg) translateY(-12px); }
.wc-opening { animation: wc-shake 0.5s; }
@keyframes wc-shake { 0%,100%{transform:rotate(0)} 25%{transform:rotate(-2deg)} 75%{transform:rotate(2deg)} }
.wc-bow { position: absolute; top: 40px; z-index: 3; font-size: 44px; filter: drop-shadow(0 4px 8px rgba(0,0,0,0.25)); }
.wc-gift-body { position: absolute; bottom: 26px; text-align: center; color: #fff; }
.wc-gift-title { font-size: 20px; font-weight: 700; }
.wc-gift-sub { font-size: 13px; opacity: 0.92; margin-top: 4px; }
.wc-card { position: relative; width: 380px; max-width: calc(100% - 32px); background: #fff; border-radius: 24px; padding: 30px 28px;
  text-align: center; box-shadow: 0 30px 70px rgba(17,29,74,0.3); overflow: hidden; }
.wc-pop { animation: wc-pop 0.4s cubic-bezier(0.2,0.9,0.3,1.3); }
@keyframes wc-pop { from { transform: scale(0.7); opacity: 0 } to { transform: scale(1); opacity: 1 } }
.wc-hooray { font-size: 22px; font-weight: 800; color: var(--text); }
.wc-quota { margin: 14px 0 6px; display: flex; flex-direction: column; gap: 2px; }
.wc-quota-usd { font-size: 38px; font-weight: 800; color: var(--accent); line-height: 1; }
.wc-quota-sub { font-size: 14px; color: var(--muted-strong, #475569); }
.wc-block { margin: 18px 0; padding: 14px; background: var(--surface-blue, #f0f6ff); border-radius: 14px; }
.wc-block-title { font-size: 13px; color: var(--muted, #667); margin-bottom: 10px; }
.wc-models { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.wc-model-chip { font-size: 13px; font-weight: 600; color: #0a3fb0; background: #dbeafe; border-radius: 999px; padding: 6px 12px; }
.wc-muted { color: var(--muted, #667); font-size: 13px; }
.wc-tip { font-size: 12px; color: var(--muted, #667); margin: 12px 0; }
.wc-err { color: var(--status-critical, #c40918); margin-bottom: 16px; }
.wc-cta { width: 100%; height: 48px; border-radius: 999px; border: 0; cursor: pointer; font-size: 16px; font-weight: 700;
  background: var(--primary, rgb(0 127 255)); color: var(--primary-foreground, rgb(255 255 255)); box-shadow: 0 12px 28px rgba(0,127,255,0.3); margin-top: 6px; }
.wc-later { width: 100%; height: 40px; border: 0; background: transparent; color: var(--muted); cursor: pointer; margin-top: 8px; }
.wc-confetti { position: absolute; inset: 0; pointer-events: none; }
.wc-confetti span { position: absolute; top: -10px; width: 8px; height: 12px; border-radius: 2px; animation: wc-fall 1.6s linear forwards; }
@keyframes wc-fall { to { transform: translateY(440px) rotate(360deg); opacity: 0 } }
`

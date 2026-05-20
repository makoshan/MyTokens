import { useState } from 'react'
import { claimRedpacket, redeemGasless } from '../api.js'
import { createWallet, loadStoredWallet, signBurnAuth, prfSupported } from '../wallet.js'

// Tokens a single MYC (≈ $1) buys at the current sell price, for guidance copy.
const TOKENS_PER_MYC = 670_000

type Stage = 'sealed' | 'opening' | 'revealed' | 'redeeming' | 'done' | 'error'

export function RedpacketClaim({ code, accountId, onClose }: { code: string; accountId: string; onClose: () => void }) {
  const [stage, setStage] = useState<Stage>('sealed')
  const [myc, setMyc] = useState(0)
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
      const wallet = loadStoredWallet() ?? (await createWallet(accountId))
      const r = await claimRedpacket(code, wallet.address)
      setMyc(r.amount_myc)
      setStage('revealed')
    } catch (e) {
      setError(humanError(e))
      setStage('error')
    }
  }

  async function redeemAll() {
    setStage('redeeming')
    try {
      const auth = await signBurnAuth(accountId, BigInt(Math.round(myc * 1e6)))
      await redeemGasless(auth as unknown as Record<string, string>)
      setStage('done')
    } catch (e) {
      setError(humanError(e))
      setStage('revealed')
    }
  }

  const usd = myc // 1 MYC = $1
  const tokens = Math.round(myc * TOKENS_PER_MYC)

  return (
    <div className="rp-overlay">
      <style>{RP_CSS}</style>
      <button className="rp-dismiss" onClick={onClose} aria-label="关闭">×</button>

      {(stage === 'sealed' || stage === 'opening') && (
        <div className={`rp-envelope ${stage === 'opening' ? 'rp-opening' : ''}`} onClick={stage === 'sealed' ? open : undefined}>
          <div className="rp-flap" />
          <div className="rp-seal">MK</div>
          <div className="rp-env-body">
            <div className="rp-env-title">AI 算力红包</div>
            <div className="rp-env-sub">{stage === 'opening' ? '正在开启…（Touch ID 确认）' : '点击拆开'}</div>
          </div>
        </div>
      )}

      {(stage === 'revealed' || stage === 'redeeming' || stage === 'done') && (
        <div className="rp-card rp-pop">
          {stage !== 'done' && <Confetti />}
          <div className="rp-amount">🎉 {myc} MYC</div>
          <div className="rp-usd">≈ ${usd} AI 算力</div>
          <div className="rp-guide">
            <div>≈ <strong>{(tokens / 10000).toLocaleString()} 万</strong> tokens 用量</div>
            <div>可跑 <strong>qwen3.6-plus</strong> / <strong>kimi</strong> 等模型</div>
          </div>
          {stage === 'done' ? (
            <>
              <div className="rp-done">✓ 已兑换 ${usd} 额度到账！</div>
              <p className="rp-done-tip">在「令牌」页拿 API key，把 Claude Code / 任意 OpenAI 兼容工具指向网关即可开跑。</p>
              <button className="rp-cta" onClick={onClose}>进入面板 →</button>
            </>
          ) : (
            <>
              <p className="rp-tip">把红包里的 MYC 兑换成 AI 额度就能用了 · 全程免 gas</p>
              <button className="rp-cta" onClick={redeemAll} disabled={stage === 'redeeming'}>
                {stage === 'redeeming' ? '兑换中…（Touch ID）' : `立即兑换 $${usd} 额度`}
              </button>
              <button className="rp-later" onClick={onClose}>稍后兑换</button>
            </>
          )}
        </div>
      )}

      {stage === 'error' && (
        <div className="rp-card">
          <div className="rp-err">✗ {error}</div>
          <button className="rp-cta" onClick={() => setStage('sealed')}>重试</button>
          <button className="rp-later" onClick={onClose}>关闭</button>
        </div>
      )}
    </div>
  )
}

function Confetti() {
  return (
    <div className="rp-confetti" aria-hidden>
      {Array.from({ length: 24 }).map((_, i) => (
        <span key={i} style={{ left: `${(i * 4.1) % 100}%`, animationDelay: `${(i % 8) * 0.12}s`, background: ['#007fff', '#0cc5ff', '#ffd23f', '#ff5e7a', '#34d399'][i % 5] }} />
      ))}
    </div>
  )
}

function humanError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  const map: Record<string, string> = {
    prf_unsupported: '这个 passkey 不支持 PRF（换个浏览器/设备）',
    passkey_create_cancelled: '已取消',
    passkey_get_cancelled: '已取消签名',
    redpacket_not_found: '红包口令无效',
    redpacket_already_claimed: '这个红包已经被领过了',
    relayer_pool_insufficient: '红包池不足，联系发红包的人',
  }
  return map[m] ?? m
}

const RP_CSS = `
.rp-overlay { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center;
  background: radial-gradient(120% 120% at 50% 0%, rgba(0,127,255,0.18), rgba(17,29,74,0.55)); backdrop-filter: blur(6px); padding: 24px; }
.rp-dismiss { position: absolute; top: 18px; right: 20px; width: 40px; height: 40px; border-radius: 999px;
  background: rgba(255,255,255,0.85); color: var(--text); font-size: 22px; border: 0; cursor: pointer; }
.rp-envelope { position: relative; width: 320px; height: 210px; border-radius: 18px; cursor: pointer;
  background: linear-gradient(160deg, #e8453c, #c4261d); box-shadow: 0 24px 60px rgba(196,38,29,0.4);
  display: grid; place-items: center; transition: transform 0.2s; }
.rp-envelope:hover { transform: translateY(-4px) scale(1.02); }
.rp-flap { position: absolute; top: 0; left: 0; right: 0; height: 96px; border-radius: 18px 18px 40% 40%;
  background: linear-gradient(160deg, #f25b52, #d63a30); transform-origin: top; transition: transform 0.6s ease; z-index: 2; }
.rp-opening .rp-flap { transform: rotateX(160deg); }
.rp-opening { animation: rp-shake 0.5s; }
@keyframes rp-shake { 0%,100%{transform:rotate(0)} 25%{transform:rotate(-2deg)} 75%{transform:rotate(2deg)} }
.rp-seal { position: absolute; top: 70px; z-index: 3; width: 52px; height: 52px; border-radius: 999px;
  background: linear-gradient(135deg, #ffd23f, #f5a623); color: #7a2e10; font-weight: 800; display: grid; place-items: center;
  box-shadow: 0 6px 14px rgba(0,0,0,0.25); }
.rp-env-body { position: absolute; bottom: 28px; text-align: center; color: #fff; }
.rp-env-title { font-size: 20px; font-weight: 700; }
.rp-env-sub { font-size: 13px; opacity: 0.9; margin-top: 4px; }
.rp-card { position: relative; width: 360px; max-width: calc(100% - 32px); background: #fff; border-radius: 24px; padding: 32px 28px;
  text-align: center; box-shadow: 0 30px 70px rgba(17,29,74,0.28); overflow: hidden; }
.rp-pop { animation: rp-pop 0.4s cubic-bezier(0.2,0.9,0.3,1.3); }
@keyframes rp-pop { from { transform: scale(0.7); opacity: 0 } to { transform: scale(1); opacity: 1 } }
.rp-amount { font-size: 34px; font-weight: 800; color: var(--text); }
.rp-usd { font-size: 16px; color: var(--accent); font-weight: 600; margin-top: 4px; }
.rp-guide { margin: 18px 0; padding: 14px; background: var(--surface-blue); border-radius: 14px; font-size: 14px; color: var(--muted-strong); line-height: 1.9; }
.rp-tip, .rp-done-tip { font-size: 13px; color: var(--muted); margin: 12px 0; }
.rp-done { font-size: 18px; font-weight: 700; color: var(--status-healthy, #228e42); margin-top: 8px; }
.rp-err { color: var(--status-critical, #c40918); margin-bottom: 16px; }
.rp-cta { width: 100%; height: 48px; border-radius: 999px; border: 0; cursor: pointer; font-size: 16px; font-weight: 700;
  background: var(--accent); color: #fff; box-shadow: 0 12px 28px rgba(0,127,255,0.3); margin-top: 6px; }
.rp-cta:disabled { opacity: 0.6; }
.rp-later { width: 100%; height: 40px; border: 0; background: transparent; color: var(--muted); cursor: pointer; margin-top: 8px; }
.rp-confetti { position: absolute; inset: 0; pointer-events: none; }
.rp-confetti span { position: absolute; top: -10px; width: 8px; height: 12px; border-radius: 2px; animation: rp-fall 1.6s linear forwards; }
@keyframes rp-fall { to { transform: translateY(420px) rotate(360deg); opacity: 0 } }
`

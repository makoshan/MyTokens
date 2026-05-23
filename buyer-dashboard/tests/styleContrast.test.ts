import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = new URL('../..', import.meta.url).pathname

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

function cssRule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))
  assert.ok(match, `missing CSS rule for ${selector}`)
  return match[1]
}

function assertReadablePrimaryButton(rule: string, label: string) {
  assert.doesNotMatch(rule, /background:\s*var\(--accent\b/, `${label} must not use the pale accent as CTA background`)
  assert.match(rule, /background:\s*var\(--primary\b/, `${label} should use the primary button background`)
  assert.match(rule, /color:\s*var\(--primary-foreground\b/, `${label} should use the primary foreground token`)
}

test('custom CTA buttons do not put white text on the pale accent surface', () => {
  const styles = readProjectFile('src/styles.css')
  assertReadablePrimaryButton(cssRule(styles, '.wallet-chip button'), 'wallet connect button')
  assertReadablePrimaryButton(cssRule(styles, '.chat-topup-btn'), 'chat top-up button')

  const passkey = readProjectFile('src/components/PasskeyLock.tsx')
  assertReadablePrimaryButton(cssRule(passkey, '.pk-cta'), 'passkey login button')

  const redpacket = readProjectFile('src/components/RedpacketClaim.tsx')
  assertReadablePrimaryButton(cssRule(redpacket, '.rp-cta'), 'red packet CTA')

  const welcome = readProjectFile('src/components/WelcomeClaim.tsx')
  assertReadablePrimaryButton(cssRule(welcome, '.wc-cta'), 'welcome claim CTA')
})

test('disabled custom CTA buttons keep readable text instead of fading the whole control', () => {
  const passkey = readProjectFile('src/components/PasskeyLock.tsx')
  assert.doesNotMatch(cssRule(passkey, '.pk-cta:disabled'), /opacity\s*:/)

  const redpacket = readProjectFile('src/components/RedpacketClaim.tsx')
  assert.doesNotMatch(cssRule(redpacket, '.rp-cta:disabled'), /opacity\s*:/)

  const styles = readProjectFile('src/styles.css')
  assert.doesNotMatch(cssRule(styles, '.wallet-chip button:disabled'), /opacity\s*:/)
})

test('top-up busy status uses readable text instead of the pale accent color', () => {
  const topup = readProjectFile('src/components/Topup.tsx')
  const styles = readProjectFile('src/styles.css')

  assert.match(topup, /className="topup-busy"/)
  assert.doesNotMatch(topup, /color:\s*'var\(--accent\)'/)
  assert.match(cssRule(styles, '.topup-busy'), /color:\s*var\(--foreground\b/)
  assert.match(cssRule(styles, '.topup-busy'), /background:\s*#eef6ff/)
  assert.match(cssRule(styles, '.topup-busy'), /border:\s*1px solid #b9d9ff/)
})

test('USDT top-up copy explains the USDT recharge and compute-token signature clearly', () => {
  const topup = readProjectFile('src/components/Topup.tsx')

  assert.match(topup, /充值 USDT：等待签名确认/)
  assert.match(topup, /签名兑换对话算力代币/)
  assert.match(topup, /先签名充值 USDT/)
  assert.match(topup, /随后签名兑换对话算力代币/)
  assert.match(topup, /充值了 \$\{formatMicroUsd\(result\.credited_micro_usd\)\} 对话算力额度/)
  assert.doesNotMatch(topup, /购买 MYC/)
  assert.doesNotMatch(topup, /钱包不留 MYC/)
  assert.doesNotMatch(topup, /MYC 已自动换好/)
})

test('test USDT faucet copy makes the one-time 10 USDT grant clear', () => {
  const topup = readProjectFile('src/components/Topup.tsx')

  assert.match(topup, /领 10 测试 USDT/)
  assert.match(topup, /测试 USDT 每个账户只能领取一次/)
})

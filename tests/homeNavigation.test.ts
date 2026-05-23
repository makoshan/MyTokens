import test from 'node:test'
import assert from 'node:assert/strict'
import {
  APP_NAV_ITEMS,
  buildHomeQuickStats,
} from '../src/utils/homeNavigation'

test('buildHomeQuickStats exposes home inventory counts for keys wallets and providers (apps entry temporarily hidden)', () => {
  const entries = buildHomeQuickStats({
    keys: 6,
    cryptoWallets: 2,
    providers: 4,
    apps: 3,
  })

  assert.deepEqual(
    entries.map((entry) => ({
      label: entry.label,
      value: entry.value,
      view: entry.view,
    })),
    [
      { label: '密钥', value: 6, view: 'keys' },
      { label: '钱包', value: 2, view: 'crypto' },
      { label: '提供商', value: 4, view: 'providers' },
    ],
  )
  // 应用入口暂时隐藏：不应再出现在首页快捷入口里。
  assert.equal(entries.some((entry) => entry.view === 'apps'), false)
})

test('APP_NAV_ITEMS exposes the focused MVP entries including compute gateway', () => {
  const views = APP_NAV_ITEMS.map((item) => item.view) as string[]
  const labels = APP_NAV_ITEMS.map((item) => item.label)

  assert.equal(views.includes('compute'), true)
  assert.equal(APP_NAV_ITEMS.some((item) => /算力/.test(item.label)), true)
  assert.equal(views.includes('history'), false)
  assert.equal(labels.includes('历史记录'), false)
  // 应用入口暂时隐藏：侧边栏不再展示 apps / 应用。
  assert.equal(views.includes('apps'), false)
  assert.equal(labels.includes('应用'), false)
  assert.deepEqual(
    ['projects', 'prompts', 'history', 'apps'].filter((view) => views.includes(view)),
    [],
  )
})

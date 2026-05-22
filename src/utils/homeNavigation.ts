export type AppNavView =
  | 'dashboard'
  | 'keys'
  | 'projects'
  | 'providers'
  | 'crypto'
  | 'apps'
  | 'mcp'
  | 'skills'
  | 'prompts'
  | 'history'
  | 'settings'
  | 'compute'

export interface AppNavItem {
  view: AppNavView
  label: string
}

export const APP_NAV_ITEMS: readonly AppNavItem[] = [
  { view: 'dashboard', label: 'Dashboard' },
  { view: 'keys', label: '密钥库' },
  { view: 'providers', label: '提供商' },
  { view: 'crypto', label: 'Crypto' },
  { view: 'apps', label: '应用' },
  { view: 'compute', label: '算力网关' },
  { view: 'settings', label: '全局设置' },
  // MVP: 项目 / MCP / Skills / 提示词 / 历史记录 入口暂不展示。
  // 视图与功能仍保留（可被程序内跳转触达），随时把对应行加回即可。
]

export type HomeQuickView = 'keys' | 'crypto' | 'providers' | 'apps'

export interface HomeQuickCounts {
  keys: number
  cryptoWallets: number
  providers: number
  apps: number
}

export interface HomeQuickEntry {
  key: HomeQuickView
  label: string
  value: number
  view: HomeQuickView
}

const HOME_QUICK_LABELS: Record<HomeQuickView, string> = {
  keys: '密钥',
  crypto: '钱包',
  providers: '提供商',
  apps: '应用',
}

const HOME_QUICK_ENTRY_ORDER: readonly HomeQuickView[] = ['keys', 'crypto', 'providers', 'apps']

export function buildHomeQuickStats(counts: HomeQuickCounts): HomeQuickEntry[] {
  return HOME_QUICK_ENTRY_ORDER.map((view) => ({
    key: view,
    label: HOME_QUICK_LABELS[view],
    value: view === 'crypto' ? counts.cryptoWallets : counts[view],
    view,
  }))
}

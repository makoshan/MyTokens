import { useCallback, useMemo, useState } from 'react'
import { loadDashboardSnapshot } from './api.js'
import { ApiKeys } from './components/ApiKeys.js'
import { Channels } from './components/Channels.js'
import { ChatPlayground } from './components/ChatPlayground.js'
import { Credits } from './components/Credits.js'
import { Docs } from './components/Docs.js'
import { ModelQuality } from './components/ModelQuality.js'
import { Overview } from './components/Overview.js'
import { RedpacketClaim } from './components/RedpacketClaim.js'
import { WelcomeClaim } from './components/WelcomeClaim.js'
import { WalletButton } from './components/WalletButton.js'
import { Topup } from './components/Topup.js'
import { isWalletConnected } from './wallet.js'
import { Usage } from './components/Usage.js'
import {
  buildDashboardViewModel,
  DEFAULT_DASHBOARD_TAB,
  tabAfterRedpacketRedeem,
  type DashboardTab,
} from './dashboardViewModel.js'
import { Button } from './token-ui.js'
import type { DashboardSnapshot } from './types.js'
import './styles.css'

export function App({ snapshot }: { snapshot: DashboardSnapshot }) {
  const [currentSnapshot, setCurrentSnapshot] = useState(snapshot)
  const [activeTab, setActiveTab] = useState<DashboardTab>(() => {
    const tabParam = new URLSearchParams(window.location.search).get('tab')
    const validTabs: DashboardTab[] = ['chat', 'overview', 'channels', 'keys', 'usage', 'quality', 'credits', 'topup', 'docs']
    return validTabs.includes(tabParam as DashboardTab) ? (tabParam as DashboardTab) : DEFAULT_DASHBOARD_TAB
  })
  const [showAdvanced, setShowAdvanced] = useState(false)
  const model = useMemo(() => buildDashboardViewModel(currentSnapshot), [currentSnapshot])
  const [redpacketCode, setRedpacketCode] = useState<string>(
    () => new URLSearchParams(window.location.search).get('redpacket') ?? ''
  )
  // Fresh manual-credit invite acceptance lands at /?welcome=1 (set by /accept).
  const [showWelcome, setShowWelcome] = useState<boolean>(
    () => new URLSearchParams(window.location.search).get('welcome') === '1'
  )
  // Models the friend was granted = the active routing rules in their snapshot
  // (already filtered to their allowlist server-side), deduped.
  const grantedModels = useMemo(
    () => [...new Set(currentSnapshot.routingRules.filter((r) => r.status === 'active').map((r) => r.requestedModel))],
    [currentSnapshot.routingRules]
  )
  const [walletConnected, setWalletConnected] = useState<boolean>(() => isWalletConnected())

  // The dashboard is served BY the gateway, so its own origin is the real Base URL —
  // far more reliable than the server's PUBLIC_GATEWAY_URL (often a placeholder).
  // Fall back to the snapshot value only for local preview (localhost).
  const effectiveBaseUrl = useMemo(() => {
    if (typeof window !== 'undefined') {
      const origin = window.location.origin
      if (/^https?:\/\//.test(origin) && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(origin)) {
        return origin
      }
    }
    return currentSnapshot.baseUrl
  }, [currentSnapshot.baseUrl])

  // Re-pull the snapshot so balance / usage reflect what a request just spent.
  const refreshSnapshot = useCallback(async () => {
    try {
      const next = await loadDashboardSnapshot()
      setCurrentSnapshot(next)
    } catch {
      // Keep the last good snapshot if the refresh fails (session blip, offline).
    }
  }, [])

  function dismissRedpacket() {
    setRedpacketCode('')
    const url = new URL(window.location.href)
    url.searchParams.delete('redpacket')
    window.history.replaceState({}, '', url.toString())
  }

  function finishRedpacketFlow() {
    dismissRedpacket()
    setActiveTab(tabAfterRedpacketRedeem())
  }

  function dismissWelcome() {
    setShowWelcome(false)
    const url = new URL(window.location.href)
    url.searchParams.delete('welcome')
    window.history.replaceState({}, '', url.toString())
    setWalletConnected(isWalletConnected()) // welcome just created + connected the wallet
    setActiveTab('chat')
  }

  return (
    <main className="console-shell">
      {redpacketCode && (
        <RedpacketClaim
          code={redpacketCode}
          accountId={currentSnapshot.account.id}
          onClose={dismissRedpacket}
          onRedeemed={finishRedpacketFlow}
        />
      )}
      {showWelcome && !redpacketCode && (
        <WelcomeClaim
          accountId={currentSnapshot.account.id}
          models={grantedModels}
          balanceMicroUsd={currentSnapshot.balanceMicroUsd}
          onClose={dismissWelcome}
        />
      )}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <span>MyKey</span>
            <strong>Compute</strong>
          </div>
        </div>
        <nav className="side-nav" aria-label="Dashboard sections">
          {model.navigation
            .filter((item) => !item.advanced)
            .map((item) => (
              <button
                key={item.id}
                type="button"
                data-slot="nav-button"
                className={activeTab === item.id ? 'active' : ''}
                onClick={() => setActiveTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          <button
            type="button"
            data-slot="nav-button"
            className="nav-advanced-toggle"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((value) => !value)}
          >
            高级功能 {showAdvanced ? '▾' : '▸'}
          </button>
          {showAdvanced &&
            model.navigation
              .filter((item) => item.advanced)
              .map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-slot="nav-button"
                  className={`nav-advanced-item ${activeTab === item.id ? 'active' : ''}`}
                  onClick={() => setActiveTab(item.id)}
                >
                  {item.label}
                </button>
              ))}
        </nav>
        <div className="sidebar-stat">
          <span>Balance</span>
          <strong>{model.balanceLabel}</strong>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">OpenAI-compatible relay</span>
            <h1>{model.accountName}</h1>
          </div>
          <WalletButton
            accountId={currentSnapshot.account.id}
            connected={walletConnected}
            onConnect={() => setWalletConnected(true)}
            onDisconnect={() => setWalletConnected(false)}
          />
          <div className="status-grid">
            <div>
              <span>Channels</span>
              <strong>
                {model.channelSummary.active}/{model.channelSummary.total}
              </strong>
            </div>
            <div>
              <span>Tokens</span>
              <strong>
                {model.tokenSummary.active}/{model.tokenSummary.total}
              </strong>
            </div>
            <div>
              <span>Quality</span>
              <strong>{model.qualitySummary}</strong>
            </div>
          </div>
        </header>

        {activeTab === 'chat' && <ChatPlayground snapshot={currentSnapshot} onRefresh={refreshSnapshot} />}
        {activeTab === 'overview' && <Overview snapshot={currentSnapshot} />}
        {activeTab === 'channels' && (
          <Channels channels={currentSnapshot.channels} routingRules={currentSnapshot.routingRules} />
        )}
        {activeTab === 'keys' && (
          <ApiKeys
            apiKeys={currentSnapshot.apiKeys}
            baseUrl={effectiveBaseUrl}
            onChange={(apiKeys) => setCurrentSnapshot((state) => ({ ...state, apiKeys }))}
          />
        )}
        {activeTab === 'usage' && <Usage rows={currentSnapshot.usage} />}
        {activeTab === 'quality' && <ModelQuality rows={currentSnapshot.modelQuality} />}
        {activeTab === 'credits' && (
          <Credits balanceMicroUsd={currentSnapshot.balanceMicroUsd} creditRequests={currentSnapshot.creditRequests} />
        )}
        {activeTab === 'topup' && (
          <Topup
            balanceMicroUsd={currentSnapshot.balanceMicroUsd}
            accountId={currentSnapshot.account.id}
            connected={walletConnected}
            onConnectChange={setWalletConnected}
          />
        )}
        {activeTab === 'docs' && <Docs snapshot={currentSnapshot} baseUrl={effectiveBaseUrl} />}
      </section>
    </main>
  )
}

export default App

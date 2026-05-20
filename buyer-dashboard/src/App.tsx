import { useMemo, useState } from 'react'
import { ApiKeys } from './components/ApiKeys.js'
import { Channels } from './components/Channels.js'
import { Credits } from './components/Credits.js'
import { Docs } from './components/Docs.js'
import { ModelQuality } from './components/ModelQuality.js'
import { Overview } from './components/Overview.js'
import { RedpacketClaim } from './components/RedpacketClaim.js'
import { Topup } from './components/Topup.js'
import { Usage } from './components/Usage.js'
import { buildDashboardViewModel } from './dashboardViewModel.js'
import { Button } from './token-ui.js'
import type { DashboardSnapshot } from './types.js'
import './styles.css'

type Tab = 'overview' | 'channels' | 'keys' | 'usage' | 'quality' | 'credits' | 'topup' | 'docs'

export function App({ snapshot }: { snapshot: DashboardSnapshot }) {
  const [activeTab, setActiveTab] = useState<Tab>('overview')
  const model = useMemo(() => buildDashboardViewModel(snapshot), [snapshot])
  const [redpacketCode, setRedpacketCode] = useState<string>(
    () => new URLSearchParams(window.location.search).get('redpacket') ?? ''
  )

  function dismissRedpacket() {
    setRedpacketCode('')
    const url = new URL(window.location.href)
    url.searchParams.delete('redpacket')
    window.history.replaceState({}, '', url.toString())
  }

  return (
    <main className="console-shell">
      {redpacketCode && (
        <RedpacketClaim code={redpacketCode} accountId={snapshot.account.id} onClose={dismissRedpacket} />
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
          {model.navigation.map((item) => (
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
          <Button variant="secondary" className="mobile-action">
            Invite
          </Button>
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

        {activeTab === 'overview' && <Overview snapshot={snapshot} />}
        {activeTab === 'channels' && (
          <Channels channels={snapshot.channels} routingRules={snapshot.routingRules} />
        )}
        {activeTab === 'keys' && <ApiKeys apiKeys={snapshot.apiKeys} baseUrl={snapshot.baseUrl} />}
        {activeTab === 'usage' && <Usage rows={snapshot.usage} />}
        {activeTab === 'quality' && <ModelQuality rows={snapshot.modelQuality} />}
        {activeTab === 'credits' && (
          <Credits balanceMicroUsd={snapshot.balanceMicroUsd} creditRequests={snapshot.creditRequests} />
        )}
        {activeTab === 'topup' && (
          <Topup balanceMicroUsd={snapshot.balanceMicroUsd} accountId={snapshot.account.id} />
        )}
        {activeTab === 'docs' && <Docs snapshot={snapshot} />}
      </section>
    </main>
  )
}

export default App

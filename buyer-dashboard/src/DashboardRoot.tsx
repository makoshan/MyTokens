import { useEffect, useState } from 'react'
import App from './App.js'
import { loadDashboardSnapshot } from './api.js'
import { localPreviewSnapshot } from './dashboardViewModel.js'
import type { DashboardSnapshot } from './types.js'

type DashboardState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: DashboardSnapshot }
  | { status: 'error'; message: string }

function isExplicitDemoMode(): boolean {
  const isLocal = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost'
  return isLocal && new URLSearchParams(window.location.search).get('preview') === '1'
}

export function DashboardRoot() {
  const [state, setState] = useState<DashboardState>(() =>
    isExplicitDemoMode() ? { status: 'ready', snapshot: localPreviewSnapshot } : { status: 'loading' }
  )

  useEffect(() => {
    if (isExplicitDemoMode()) return
    let cancelled = false
    loadDashboardSnapshot()
      .then((snapshot) => {
        if (!cancelled) setState({ status: 'ready', snapshot })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'dashboard_api_failed'
          setState({ status: 'error', message })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (state.status === 'loading') {
    return (
      <main className="auth-state">
        <div data-slot="card">
          <div data-slot="card-header">
            <div>
              <div data-slot="card-description">MyKey Compute</div>
              <h2 data-slot="card-title">Loading dashboard</h2>
            </div>
          </div>
        </div>
      </main>
    )
  }

  if (state.status === 'error') {
    return (
      <main className="auth-state">
        <div data-slot="card">
          <div data-slot="card-header">
            <div>
              <div data-slot="card-description">Dashboard session required</div>
              <h2 data-slot="card-title">Unable to load account data</h2>
            </div>
          </div>
          <div data-slot="card-content">
            <p>{state.message}</p>
            <p className="muted">Open a valid invite link or use a signed-in dashboard session.</p>
          </div>
        </div>
      </main>
    )
  }

  return <App snapshot={state.snapshot} />
}

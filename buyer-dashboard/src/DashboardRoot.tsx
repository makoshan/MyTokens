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
    // 403 = the operator revoked this friend (account disabled), as opposed to a
    // missing/expired session. Show clear copy instead of a raw error code.
    const cutOff = state.message.endsWith(':403')
    return (
      <main className="auth-state">
        <div data-slot="card">
          <div data-slot="card-header">
            <div>
              <div data-slot="card-description">{cutOff ? '访问已被取消' : 'Dashboard session required'}</div>
              <h2 data-slot="card-title">{cutOff ? '运营者已停用此账户' : 'Unable to load account data'}</h2>
            </div>
          </div>
          <div data-slot="card-content">
            {cutOff ? (
              <p className="muted">你的算力访问已被运营者取消，API Key 与网页都已停用。如需恢复，请联系邀请你的人。</p>
            ) : (
              <>
                <p>{state.message}</p>
                <p className="muted">Open a valid invite link or use a signed-in dashboard session.</p>
              </>
            )}
          </div>
        </div>
      </main>
    )
  }

  return <App snapshot={state.snapshot} />
}

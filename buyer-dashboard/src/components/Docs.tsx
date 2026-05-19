import { buildDashboardViewModel } from '../dashboardViewModel.js'
import type { DashboardSnapshot } from '../types.js'
import { Card, CardContent, PanelTitle } from '../token-ui.js'

export function Docs({ snapshot }: { snapshot: DashboardSnapshot }) {
  const model = buildDashboardViewModel(snapshot)
  return (
    <Card>
      <PanelTitle eyebrow="OpenAI-compatible client setup" title="文档" />
      <CardContent>
      <div className="doc-grid">
        <div>
          <span className="muted">Base URL</span>
          <code>{snapshot.baseUrl}</code>
        </div>
        <div>
          <span className="muted">Endpoint</span>
          <code>POST /v1/responses</code>
        </div>
      </div>
      <pre>{model.quickStartCurl}</pre>
      </CardContent>
    </Card>
  )
}

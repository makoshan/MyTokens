import type { DashboardSnapshot } from '../types.js'
import { buildDashboardViewModel, formatMicroUsd } from '../dashboardViewModel.js'
import { Card, CardContent, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../token-ui.js'

export function Overview({ snapshot }: { snapshot: DashboardSnapshot }) {
  const model = buildDashboardViewModel(snapshot)
  return (
    <Card>
      <CardContent>
        <div className="metric-grid">
        <div className="metric">
          <span>Balance</span>
          <strong>{model.balanceLabel}</strong>
        </div>
        <div className="metric">
          <span>Today</span>
          <strong>{model.todaySpendLabel}</strong>
        </div>
        <div className="metric">
          <span>Tokens</span>
          <strong>{model.totalTokensToday.toLocaleString()}</strong>
        </div>
        <div className="metric">
          <span>Channels</span>
          <strong>{model.channelSummary.active}</strong>
        </div>
        <div className="metric">
          <span>Keys</span>
          <strong>{model.tokenSummary.active}</strong>
        </div>
        <div className="metric">
          <span>Status</span>
          <strong>{model.accountStatus}</strong>
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Recent request</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Tokens</TableHead>
            <TableHead>Cost</TableHead>
            <TableHead>Latency</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {snapshot.usage.slice(0, 5).map((row) => (
            <TableRow key={row.id}>
              <TableCell>{row.id}</TableCell>
              <TableCell>{row.model}</TableCell>
              <TableCell>{row.inputTokens + row.outputTokens}</TableCell>
              <TableCell>{formatMicroUsd(row.costMicroUsd)}</TableCell>
              <TableCell>{row.latencyMs} ms</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </CardContent>
    </Card>
  )
}

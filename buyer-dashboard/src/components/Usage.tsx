import { formatMicroUsd } from '../dashboardViewModel.js'
import type { UsageRow } from '../types.js'
import { Card, CardContent, PanelTitle, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../token-ui.js'

export function Usage({ rows }: { rows: UsageRow[] }) {
  return (
    <Card>
      <PanelTitle eyebrow="Usage ledger" title="日志" />
      <CardContent>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Request</TableHead>
            <TableHead>Time</TableHead>
            <TableHead>Endpoint</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Input</TableHead>
            <TableHead>Output</TableHead>
            <TableHead>Cost</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>{row.id}</TableCell>
              <TableCell>{new Date(row.createdAt).toLocaleTimeString()}</TableCell>
              <TableCell>{row.endpoint}</TableCell>
              <TableCell>{row.model}</TableCell>
              <TableCell>{row.inputTokens}</TableCell>
              <TableCell>{row.outputTokens}</TableCell>
              <TableCell>{formatMicroUsd(row.costMicroUsd)}</TableCell>
              <TableCell>
                <StatusBadge status={row.status === 'ok' ? 'active' : row.status} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </CardContent>
    </Card>
  )
}

import type { ModelQualityRow } from '../types.js'
import { Button, Card, CardContent, PanelTitle, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../token-ui.js'

export function ModelQuality({ rows }: { rows: ModelQualityRow[] }) {
  return (
    <Card>
      <PanelTitle eyebrow="Authenticity and performance" title="模型检测" action={<Button>Run probe</Button>} />
      <CardContent>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Model</TableHead>
            <TableHead>Quality</TableHead>
            <TableHead>Channel</TableHead>
            <TableHead>Latency</TableHead>
            <TableHead>TPS</TableHead>
            <TableHead>Error rate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.model}>
              <TableCell>{row.model}</TableCell>
              <TableCell>
                <StatusBadge status={row.label} />
              </TableCell>
              <TableCell>
                <StatusBadge status={row.channelStatus} />
              </TableCell>
              <TableCell>{row.latencyMs} ms</TableCell>
              <TableCell>{row.tokensPerSecond}</TableCell>
              <TableCell>{Math.round(row.recentErrorRate * 100)}%</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </CardContent>
    </Card>
  )
}

import { formatMicroUsd } from '../dashboardViewModel.js'
import type { CreditRequestRow } from '../types.js'
import { Button, Card, CardContent, PanelTitle, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../token-ui.js'

export function Credits({
  balanceMicroUsd,
  creditRequests,
}: {
  balanceMicroUsd: number
  creditRequests: CreditRequestRow[]
}) {
  return (
    <Card>
      <PanelTitle eyebrow="Manual credit mode" title="额度" action={<Button>Request credit</Button>} />
      <CardContent className="split">
      <div>
        <span className="muted">Available</span>
        <strong className="balance">{formatMicroUsd(balanceMicroUsd)}</strong>
      </div>
      <div>
        <div className="toolbar">
          <span className="muted">Credit requests</span>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Message</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {creditRequests.map((request) => (
              <TableRow key={request.id}>
                <TableCell>{formatMicroUsd(request.requestedMicroUsd)}</TableCell>
                <TableCell>
                  <StatusBadge status={request.status} />
                </TableCell>
                <TableCell>{request.message ?? ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      </CardContent>
    </Card>
  )
}

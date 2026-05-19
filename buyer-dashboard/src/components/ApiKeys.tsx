import type { DashboardApiKey } from '../types.js'
import { formatMicroUsd, maskApiKey } from '../dashboardViewModel.js'
import {
  Button,
  Card,
  CardContent,
  PanelTitle,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../token-ui.js'

export function ApiKeys({ apiKeys, baseUrl }: { apiKeys: DashboardApiKey[]; baseUrl: string }) {
  return (
    <Card>
      <PanelTitle eyebrow="OpenAI-compatible access" title="令牌" action={<Button>Create key</Button>} />
      <CardContent>
      <div className="toolbar">
        <code>{baseUrl}</code>
        <Button variant="outline">Copy base URL</Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Key</TableHead>
            <TableHead>Quota</TableHead>
            <TableHead>Used</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Created</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {apiKeys.map((key) => (
            <TableRow key={key.id}>
              <TableCell>{key.name}</TableCell>
              <TableCell>
                <code>{maskApiKey(key.prefix, key.last4)}</code>
              </TableCell>
              <TableCell>{typeof key.quotaMicroUsd === 'number' ? formatMicroUsd(key.quotaMicroUsd) : '-'}</TableCell>
              <TableCell>{typeof key.usedMicroUsd === 'number' ? formatMicroUsd(key.usedMicroUsd) : '-'}</TableCell>
              <TableCell>
                <StatusBadge status={key.status} />
              </TableCell>
              <TableCell>{new Date(key.createdAt).toLocaleDateString()}</TableCell>
              <TableCell>
                <Button variant="ghost" size="sm">
                  Revoke
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </CardContent>
    </Card>
  )
}

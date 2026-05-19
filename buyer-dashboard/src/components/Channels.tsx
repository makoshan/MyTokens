import type { ChannelStatusRow, RoutingRuleRow } from '../types.js'
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

export function Channels({
  channels,
  routingRules,
}: {
  channels: ChannelStatusRow[]
  routingRules: RoutingRuleRow[]
}) {
  return (
    <Card className="stack-panel">
      <PanelTitle eyebrow="Provider channels" title="渠道" action={<Button variant="outline">Refresh</Button>} />
      <CardContent>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Channel</TableHead>
            <TableHead>Provider</TableHead>
            <TableHead>Models</TableHead>
            <TableHead>Priority</TableHead>
            <TableHead>Weight</TableHead>
            <TableHead>Latency</TableHead>
            <TableHead>Error</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {channels.map((channel) => (
            <TableRow key={channel.id}>
              <TableCell>{channel.label}</TableCell>
              <TableCell>{channel.provider}</TableCell>
              <TableCell>{channel.models.join(', ')}</TableCell>
              <TableCell>{channel.priority}</TableCell>
              <TableCell>{channel.weight}</TableCell>
              <TableCell>{channel.latencyMs} ms</TableCell>
              <TableCell>{Math.round(channel.errorRate * 100)}%</TableCell>
              <TableCell>
                <StatusBadge status={channel.status} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="subsection">
        <span className="muted">Routing rules</span>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Group</TableHead>
              <TableHead>Requested</TableHead>
              <TableHead>Actual</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {routingRules.map((rule) => (
              <TableRow key={rule.id}>
                <TableCell>{rule.group}</TableCell>
                <TableCell>{rule.requestedModel}</TableCell>
                <TableCell>{rule.actualModel}</TableCell>
                <TableCell>{rule.channelLabel}</TableCell>
                <TableCell>
                  <StatusBadge status={rule.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      </CardContent>
    </Card>
  )
}

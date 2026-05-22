import { useEffect, useState } from 'react'
import { createDashboardApiKey, revokeDashboardApiKey } from '../api.js'
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

export function ApiKeys({
  apiKeys,
  baseUrl,
  onChange,
}: {
  apiKeys: DashboardApiKey[]
  baseUrl: string
  onChange?: (apiKeys: DashboardApiKey[]) => void
}) {
  const [keys, setKeys] = useState(apiKeys)
  const [keyName, setKeyName] = useState('Claude Code')
  const [rawKey, setRawKey] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => setKeys(apiKeys), [apiKeys])

  function commitKeys(next: DashboardApiKey[]) {
    setKeys(next)
    onChange?.(next)
  }

  async function copyText(value: string, label: string) {
    try {
      if (!navigator.clipboard) throw new Error('clipboard_unavailable')
      await navigator.clipboard.writeText(value)
      setMessage({ ok: true, text: `${label} 已复制` })
    } catch {
      setMessage({ ok: false, text: `无法复制 ${label}` })
    }
  }

  async function onCreate() {
    setBusy('create')
    setMessage(null)
    try {
      const created = await createDashboardApiKey(keyName)
      commitKeys([created.key, ...keys])
      setRawKey(created.rawKey)
      setMessage({ ok: true, text: 'MyKey API Key 已创建，完整 key 只显示这一次。' })
    } catch (e) {
      setMessage({ ok: false, text: humanError(e) })
    } finally {
      setBusy(null)
    }
  }

  async function onRevoke(keyId: string) {
    setBusy(keyId)
    setMessage(null)
    try {
      await revokeDashboardApiKey(keyId)
      commitKeys(keys.map((key) => (key.id === keyId ? { ...key, status: 'revoked' } : key)))
      setMessage({ ok: true, text: 'MyKey API Key 已撤销。' })
    } catch (e) {
      setMessage({ ok: false, text: humanError(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <PanelTitle
        eyebrow="OpenAI-compatible access"
        title="MyKey API Key"
        action={<Button onClick={onCreate} disabled={!!busy}>{busy === 'create' ? '创建中…' : '创建 API key'}</Button>}
      />
      <CardContent>
      <div className="key-create-row">
        <label>
          <span className="muted">Key name</span>
          <input value={keyName} onChange={(event) => setKeyName(event.target.value)} placeholder="Claude Code" />
        </label>
      </div>

      <div className="toolbar">
        <div>
          <span className="muted">Base URL</span>
          <code>{baseUrl}</code>
        </div>
        <Button variant="outline" onClick={() => copyText(baseUrl, 'Base URL')}>复制 Base URL</Button>
      </div>

      {rawKey && (
        <div className="key-secret-panel">
          <span className="muted">完整 MyKey API Key（只显示一次）</span>
          <code>{rawKey}</code>
          <div className="key-secret-actions">
            <Button onClick={() => copyText(rawKey, 'API key')}>复制 API key</Button>
            <Button variant="outline" onClick={() => copyText(`OPENAI_API_KEY=${rawKey}\nOPENAI_BASE_URL=${baseUrl}/v1`, '客户端配置')}>
              复制客户端配置
            </Button>
          </div>
        </div>
      )}

      {message && (
        <p className={message.ok ? 'status-message status-message--ok' : 'status-message status-message--error'}>
          {message.text}
        </p>
      )}

      <p className="muted api-key-help">
        网页里可以直接查看余额、日志和模型状态；在 Claude Code 或任意 OpenAI-compatible 客户端里使用时，复制 Base URL 和 MyKey API Key。
      </p>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>MyKey API Key</TableHead>
            <TableHead>Quota</TableHead>
            <TableHead>Used</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Created</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map((key) => (
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
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRevoke(key.id)}
                  disabled={!!busy || key.status === 'revoked'}
                >
                  {busy === key.id ? '撤销中…' : '撤销'}
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {keys.length === 0 && (
            <TableRow>
              <TableCell colSpan={7}>还没有 MyKey API Key。创建一个即可把客户端指向这个网关。</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      </CardContent>
    </Card>
  )
}

function humanError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  const map: Record<string, string> = {
    dashboard_auth_required: '登录已失效，请重新打开邀请链接。',
    server_pepper_not_configured: '网关密钥服务未配置，请联系发起人。',
    api_key_not_found: '这个 API key 不存在或已撤销。',
    api_key_missing_raw_key: '网关没有返回完整 key，请重试。',
  }
  return map[message] ?? message
}

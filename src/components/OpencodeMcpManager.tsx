import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { AppIntegration } from '../types/settings'
import './OpencodeToolsManager.css'

interface IntegrationConfigSnapshot {
  app_type: string
  config_path: string
  config: unknown
}

type McpType = 'stdio' | 'sse' | 'http'

interface McpItem {
  id: string
  appType: string
  configPath: string
  source: 'integration' | 'tool-manager'
  name: string
  content: string
  mcpType: McpType
  hint: string
}

interface EditState {
  mode: 'create' | 'edit'
  itemId?: string
  appType: string
  name: string
  content: string
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function appLabel(appType: string): string {
  const labels: Record<string, string> = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
    gemini: 'Gemini',
    cursor: 'Cursor',
    opencode: 'OpenCode',
    openclaw: 'OpenClaw',
    'claude-code-tool-manager': 'Claude Code Tool Manager',
  }
  return labels[appType] || appType
}

function isVisible(appType: string): boolean {
  return appType !== 'openai-compatible' && appType !== 'claude'
}

function detectMcpType(value: Record<string, unknown>): McpType {
  if (typeof value.command === 'string' || Array.isArray(value.command)) return 'stdio'
  const url = typeof value.url === 'string' ? value.url : ''
  if (url.toLowerCase().includes('sse')) return 'sse'
  return 'http'
}

function buildHint(value: Record<string, unknown>, mcpType: McpType): string {
  if (mcpType === 'stdio') {
    if (typeof value.command === 'string') return value.command
    if (Array.isArray(value.command) && typeof value.command[0] === 'string') return value.command[0]
    return 'stdio command'
  }
  const url = typeof value.url === 'string' ? value.url : ''
  if (!url) return mcpType === 'sse' ? 'SSE endpoint' : 'HTTP endpoint'
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function parseJsonObject(label: string, source: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (err) {
    throw new Error(`${label} JSON 无效: ${String(err)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 对象`)
  }
  return parsed as Record<string, unknown>
}

export default function OpencodeMcpManager({ masterPassword }: { masterPassword: string }) {
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | McpType>('all')
  const [notice, setNotice] = useState<string | null>(null)
  const [openingPath, setOpeningPath] = useState('')
  const [integrations, setIntegrations] = useState<AppIntegration[]>([])
  const [snapshotsByApp, setSnapshotsByApp] = useState<Record<string, IntegrationConfigSnapshot>>({})
  const [items, setItems] = useState<McpItem[]>([])
  const [editing, setEditing] = useState<EditState | null>(null)
  const [saving, setSaving] = useState(false)

  const loadData = async () => {
    if (!masterPassword) return
    setLoading(true)
    setNotice(null)
    try {
      const settings = await invoke<{ integrations: AppIntegration[] }>('get_global_settings', {
        masterPassword,
      })
      const visible = settings.integrations
        .filter((item) => isVisible(item.app_type))
        .sort((a, b) => appLabel(a.app_type).localeCompare(appLabel(b.app_type)))

      const settled = await Promise.allSettled(
        visible.map((integration) =>
          invoke<IntegrationConfigSnapshot>('get_integration_config_snapshot', {
            appType: integration.app_type,
            masterPassword,
          })
        )
      )

      const nextByApp: Record<string, IntegrationConfigSnapshot> = {}
      const nextItems: McpItem[] = []

      settled.forEach((result) => {
        if (result.status !== 'fulfilled') return
        const snapshot = result.value
        nextByApp[snapshot.app_type] = snapshot
        const root = asRecord(snapshot.config)
        const mcp = asRecord(root.mcp ?? root.mcpServers ?? root.mcps)
        Object.entries(mcp).forEach(([name, value]) => {
          const obj = asRecord(value)
          const mcpType = detectMcpType(obj)
          nextItems.push({
            id: randomId(),
            appType: snapshot.app_type,
            configPath: snapshot.config_path,
            source: 'integration',
            name,
            content: formatJson(obj),
            mcpType,
            hint: buildHint(obj, mcpType),
          })
        })
      })

      try {
        const toolManagerMcps = await invoke<
          Array<{
            name: string
            mcp_type: string
            description?: string | null
            command?: string | null
            url?: string | null
          }>
        >('get_claude_tool_manager_mcps', { masterPassword })
        toolManagerMcps.forEach((mcp) => {
          const mcpType: McpType =
            mcp.mcp_type === 'stdio' || mcp.mcp_type === 'sse' || mcp.mcp_type === 'http'
              ? mcp.mcp_type
              : 'http'
          const command = mcp.command || ''
          const url = mcp.url || ''
          const content = formatJson(
            mcpType === 'stdio'
              ? { command, args: [] }
              : {
                  url,
                }
          )
          nextItems.push({
            id: randomId(),
            appType: 'claude-code-tool-manager',
            configPath: '~/Library/Application Support/com.claude-code-tool-manager.app/mcp_library.db',
            source: 'tool-manager',
            name: mcp.name,
            content,
            mcpType,
            hint: command || (url ? buildHint({ url }, mcpType) : mcp.description || ''),
          })
        })
      } catch (err) {
        console.error('load tool manager mcps failed', err)
      }

      setIntegrations(visible)
      setSnapshotsByApp(nextByApp)
      setItems(nextItems)
    } catch (err) {
      console.error(err)
      setIntegrations([])
      setSnapshotsByApp({})
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [masterPassword])

  const filteredItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return items.filter((item) => {
      if (typeFilter !== 'all' && item.mcpType !== typeFilter) return false
      if (!query) return true
      return (
        item.name.toLowerCase().includes(query) ||
        item.appType.toLowerCase().includes(query) ||
        item.hint.toLowerCase().includes(query)
      )
    })
  }, [items, searchQuery, typeFilter])

  const typeCount = useMemo(() => {
    return {
      total: items.length,
      stdio: items.filter((item) => item.mcpType === 'stdio').length,
      sse: items.filter((item) => item.mcpType === 'sse').length,
      http: items.filter((item) => item.mcpType === 'http').length,
    }
  }, [items])

  const persistApp = async (appType: string, nextItems: McpItem[]) => {
    const snapshot = snapshotsByApp[appType]
    if (!snapshot) throw new Error(`应用 ${appType} 未加载快照`)

    const root = asRecord(snapshot.config)
    const mcpKey = 'mcpServers' in root ? 'mcpServers' : 'mcps' in root ? 'mcps' : 'mcp'
    const mcp: Record<string, unknown> = {}
    nextItems
      .filter((item) => item.appType === appType)
      .forEach((item) => {
        const parsed = parseJsonObject(item.name, item.content)
        mcp[item.name.trim()] = parsed
      })

    await invoke('save_integration_config_snapshot', {
      appType,
        config: {
          ...root,
          [mcpKey]: mcp,
        },
      masterPassword,
    })
  }

  const openConfigPath = async (path: string) => {
    if (!path) return
    setOpeningPath(path)
    try {
      await invoke('open_path', { path })
    } catch (err) {
      alert(`打开配置失败: ${String(err)}`)
    } finally {
      setOpeningPath('')
    }
  }

  const handleDelete = async (item: McpItem) => {
    if (item.source === 'tool-manager') {
      alert('该条目来自 Claude Code Tool Manager 数据库，请在原应用中编辑。')
      return
    }
    const next = items.filter((entry) => entry.id !== item.id)
    try {
      await persistApp(item.appType, next)
      setItems(next)
      setNotice(`已删除 ${item.name}`)
    } catch (err) {
      alert(`删除失败: ${String(err)}`)
    }
  }

  const handleDuplicate = async (item: McpItem) => {
    if (item.source === 'tool-manager') {
      alert('该条目来自 Claude Code Tool Manager 数据库，请在原应用中编辑。')
      return
    }
    const baseName = `${item.name}-copy`
    const appNames = new Set(items.filter((entry) => entry.appType === item.appType).map((entry) => entry.name))
    let candidate = baseName
    let idx = 2
    while (appNames.has(candidate)) {
      candidate = `${baseName}-${idx}`
      idx += 1
    }
    const duplicate: McpItem = { ...item, id: randomId(), name: candidate }
    const next = [duplicate, ...items]
    try {
      await persistApp(item.appType, next)
      setItems(next)
      setNotice(`已复制 ${item.name}`)
    } catch (err) {
      alert(`复制失败: ${String(err)}`)
    }
  }

  const handleSubmitEdit = async () => {
    if (!editing) return
    const appType = editing.appType.trim()
    const name = editing.name.trim()
    if (!appType) {
      alert('请选择应用')
      return
    }
    if (!name) {
      alert('名称不能为空')
      return
    }
    let parsed: Record<string, unknown>
    try {
      parsed = parseJsonObject(name, editing.content)
    } catch (err) {
      alert(String(err))
      return
    }

    setSaving(true)
    try {
      const nextItem: McpItem = {
        id: editing.itemId || randomId(),
        appType,
        configPath: snapshotsByApp[appType]?.config_path || '',
        source: 'integration',
        name,
        content: formatJson(parsed),
        mcpType: detectMcpType(parsed),
        hint: buildHint(parsed, detectMcpType(parsed)),
      }

      const next =
        editing.mode === 'create'
          ? [nextItem, ...items]
          : items.map((item) => (item.id === editing.itemId ? nextItem : item))

      await persistApp(appType, next)
      setItems(next)
      setEditing(null)
      setNotice(editing.mode === 'create' ? 'MCP 已创建' : 'MCP 已更新')
    } catch (err) {
      alert(`保存失败: ${String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <section className="panel">
        <div className="panel-empty">加载 MCP 配置中...</div>
      </section>
    )
  }

  return (
    <section className="panel opencode-tools-view">
      <div className="tool-page-header">
        <div>
          <div className="tool-page-title">
            <h2>MCP Library</h2>
            <span className="panel-count">{typeCount.total}</span>
          </div>
          <p className="tool-page-subtitle">参考 claude-code-tool-manager 的 MCP 管理布局与交互</p>
        </div>
        <div className="opencode-tools-actions">
          <a className="btn btn-secondary" href="https://opencode.ai/docs/mcp-servers/" target="_blank" rel="noreferrer">
            MCP 文档
          </a>
          <button className="btn btn-secondary" onClick={loadData}>
            刷新
          </button>
          <button
            className="btn btn-primary"
            onClick={() =>
              setEditing({
                mode: 'create',
                appType: integrations[0]?.app_type || 'opencode',
                name: '',
                content: formatJson({ command: '', args: [] }),
              })
            }
          >
            + Add MCP
          </button>
        </div>
      </div>

      {notice ? <div className="opencode-tools-notice">{notice}</div> : null}

      <div className="tool-toolbar">
        <div className="tool-search">
          <input
            type="text"
            placeholder="Search MCPs..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>
        <div className="tool-meta">{filteredItems.length} visible</div>
      </div>

      <div className="tool-filter-row">
        <button
          className={`tool-filter-chip ${typeFilter === 'all' ? 'active' : ''}`}
          onClick={() => setTypeFilter('all')}
        >
          All ({typeCount.total})
        </button>
        <button
          className={`tool-filter-chip ${typeFilter === 'stdio' ? 'active' : ''}`}
          onClick={() => setTypeFilter('stdio')}
        >
          stdio ({typeCount.stdio})
        </button>
        <button
          className={`tool-filter-chip ${typeFilter === 'sse' ? 'active' : ''}`}
          onClick={() => setTypeFilter('sse')}
        >
          SSE ({typeCount.sse})
        </button>
        <button
          className={`tool-filter-chip ${typeFilter === 'http' ? 'active' : ''}`}
          onClick={() => setTypeFilter('http')}
        >
          HTTP ({typeCount.http})
        </button>
      </div>

      {filteredItems.length === 0 ? (
        <div className="tool-empty">没有匹配的 MCP 条目</div>
      ) : (
        <div className="tool-grid">
          {filteredItems.map((item) => (
            <article key={item.id} className="tool-card">
              <div className="tool-card-top">
                <div>
                  <h3 className="tool-card-title">{item.name}</h3>
                  <p className="tool-card-path">{item.configPath}</p>
                </div>
                <div className="tool-card-badges">
                  <span className={`tool-badge type-${item.mcpType}`}>{item.mcpType}</span>
                  <span className="tool-badge">{appLabel(item.appType)}</span>
                  {item.source === 'tool-manager' ? <span className="tool-badge">DB</span> : null}
                </div>
              </div>
              <p className="tool-card-desc">{item.hint}</p>
              <div className="tool-card-actions">
                <button
                  className="btn btn-secondary"
                  disabled={item.source === 'tool-manager'}
                  onClick={() =>
                    setEditing({
                      mode: 'edit',
                      itemId: item.id,
                      appType: item.appType,
                      name: item.name,
                      content: item.content,
                    })
                  }
                >
                  Edit
                </button>
                <button className="btn btn-secondary" onClick={() => handleDuplicate(item)}>
                  Duplicate
                </button>
                <button className="btn btn-secondary" onClick={() => openConfigPath(item.configPath)} disabled={openingPath === item.configPath}>
                  Open
                </button>
                <button className="btn btn-danger" onClick={() => handleDelete(item)}>
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {editing ? (
        <div className="tool-modal-backdrop" onClick={() => setEditing(null)}>
          <div className="tool-modal" onClick={(event) => event.stopPropagation()}>
            <h3>{editing.mode === 'create' ? 'Add New MCP' : 'Edit MCP'}</h3>
            <div className="form-group">
              <label>目标应用</label>
              <select
                value={editing.appType}
                onChange={(event) => setEditing((prev) => (prev ? { ...prev, appType: event.target.value } : prev))}
              >
                {integrations.map((integration) => (
                  <option key={integration.app_type} value={integration.app_type}>
                    {appLabel(integration.app_type)}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>MCP 名称</label>
              <input
                type="text"
                value={editing.name}
                onChange={(event) => setEditing((prev) => (prev ? { ...prev, name: event.target.value } : prev))}
                placeholder="filesystem"
              />
            </div>
            <div className="form-group">
              <label>MCP JSON</label>
              <textarea
                value={editing.content}
                onChange={(event) => setEditing((prev) => (prev ? { ...prev, content: event.target.value } : prev))}
              />
            </div>
            <div className="tool-modal-actions">
              <button className="btn btn-secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleSubmitEdit} disabled={saving}>
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { AppIntegration } from '../types/settings'
import './OpencodeToolsManager.css'

interface IntegrationConfigSnapshot {
  app_type: string
  config_path: string
  config: unknown
}

interface SkillItem {
  id: string
  appType: string
  configPath: string
  source: 'integration' | 'tool-manager'
  skillKey: 'skill' | 'skills'
  name: string
  content: string
  tags: string[]
  description: string
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

function resolveSkillKey(root: Record<string, unknown>): 'skill' | 'skills' {
  if ('skill' in root) return 'skill'
  return 'skills'
}

function pickSkillEntries(root: Record<string, unknown>, key: 'skill' | 'skills'): Record<string, unknown> {
  const base = asRecord(root[key])
  if ('entries' in base && asRecord(base.entries) && Object.keys(asRecord(base.entries)).length > 0) {
    return asRecord(base.entries)
  }
  return base
}

function extractSkillMeta(value: Record<string, unknown>): { tags: string[]; description: string } {
  const tagsRaw = value.tags
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.filter((tag) => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean)
    : []
  const description = typeof value.description === 'string' ? value.description : ''
  return { tags, description }
}

export default function OpencodeSkillManager({ masterPassword }: { masterPassword: string }) {
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [openingPath, setOpeningPath] = useState('')
  const [integrations, setIntegrations] = useState<AppIntegration[]>([])
  const [snapshotsByApp, setSnapshotsByApp] = useState<Record<string, IntegrationConfigSnapshot>>({})
  const [items, setItems] = useState<SkillItem[]>([])
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
      const nextItems: SkillItem[] = []

      settled.forEach((result) => {
        if (result.status !== 'fulfilled') return
        const snapshot = result.value
        nextByApp[snapshot.app_type] = snapshot
        const root = asRecord(snapshot.config)
        const skillKey = resolveSkillKey(root)
        const skills = pickSkillEntries(root, skillKey)
        Object.entries(skills).forEach(([name, value]) => {
          const obj = asRecord(value)
          const meta = extractSkillMeta(obj)
          nextItems.push({
            id: randomId(),
            appType: snapshot.app_type,
            configPath: snapshot.config_path,
            source: 'integration',
            skillKey,
            name,
            content: formatJson(obj),
            tags: meta.tags,
            description: meta.description,
          })
        })
      })

      try {
        const toolManagerSkills = await invoke<
          Array<{ name: string; description?: string | null; tags?: string[] }>
        >('get_claude_tool_manager_skills', { masterPassword })
        toolManagerSkills.forEach((skill) => {
          const content = formatJson({
            description: skill.description || '',
            tags: Array.isArray(skill.tags) ? skill.tags : [],
          })
          nextItems.push({
            id: randomId(),
            appType: 'claude-code-tool-manager',
            configPath: '~/Library/Application Support/com.claude-code-tool-manager.app/mcp_library.db',
            source: 'tool-manager',
            skillKey: 'skills',
            name: skill.name,
            content,
            tags: Array.isArray(skill.tags) ? skill.tags : [],
            description: skill.description || '',
          })
        })
      } catch (err) {
        console.error('load tool manager skills failed', err)
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
    if (!query) return items
    return items.filter((item) => {
      if (item.name.toLowerCase().includes(query)) return true
      if (item.appType.toLowerCase().includes(query)) return true
      if (item.description.toLowerCase().includes(query)) return true
      return item.tags.some((tag) => tag.toLowerCase().includes(query))
    })
  }, [items, searchQuery])

  const persistApp = async (appType: string, nextItems: SkillItem[]) => {
    const snapshot = snapshotsByApp[appType]
    if (!snapshot) throw new Error(`应用 ${appType} 未加载快照`)

    const appItems = nextItems.filter((item) => item.appType === appType)
    const key = appItems[0]?.skillKey || resolveSkillKey(asRecord(snapshot.config))
    const root = asRecord(snapshot.config)
    const hasEntriesEnvelope = 'entries' in asRecord(root[key])
    const skills: Record<string, unknown> = {}

    appItems.forEach((item) => {
      const parsed = parseJsonObject(item.name, item.content)
      skills[item.name.trim()] = parsed
    })

    const nextRoot: Record<string, unknown> = {
      ...root,
      [key]: hasEntriesEnvelope ? { ...asRecord(root[key]), entries: skills } : skills,
    }
    if (key === 'skill') {
      delete nextRoot.skills
    } else {
      delete nextRoot.skill
    }

    await invoke('save_integration_config_snapshot', {
      appType,
      config: nextRoot,
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

  const handleDelete = async (item: SkillItem) => {
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
      const original = editing.itemId ? items.find((item) => item.id === editing.itemId) : null
      const nextItem: SkillItem = {
        id: editing.itemId || randomId(),
        appType,
        configPath: snapshotsByApp[appType]?.config_path || '',
        source: 'integration',
        skillKey: original?.skillKey || resolveSkillKey(asRecord(snapshotsByApp[appType]?.config)),
        name,
        content: formatJson(parsed),
        tags: extractSkillMeta(parsed).tags,
        description: extractSkillMeta(parsed).description,
      }

      const next =
        editing.mode === 'create'
          ? [nextItem, ...items]
          : items.map((item) => (item.id === editing.itemId ? nextItem : item))

      await persistApp(appType, next)
      setItems(next)
      setEditing(null)
      setNotice(editing.mode === 'create' ? 'Skill 已创建' : 'Skill 已更新')
    } catch (err) {
      alert(`保存失败: ${String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <section className="panel">
        <div className="panel-empty">加载 Skills 配置中...</div>
      </section>
    )
  }

  return (
    <section className="panel opencode-tools-view">
      <div className="tool-page-header">
        <div>
          <div className="tool-page-title">
            <h2>Skills Library</h2>
            <span className="panel-count">{items.length}</span>
          </div>
          <p className="tool-page-subtitle">参考 claude-code-tool-manager 的 Skills 管理布局与交互</p>
        </div>
        <div className="opencode-tools-actions">
          <a className="btn btn-secondary" href="https://opencode.ai/docs/skills/" target="_blank" rel="noreferrer">
            Skills 文档
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
                content: formatJson({ description: '', tags: [] }),
              })
            }
          >
            + Add Skill
          </button>
        </div>
      </div>

      {notice ? <div className="opencode-tools-notice">{notice}</div> : null}

      <div className="tool-toolbar">
        <div className="tool-search">
          <input
            type="text"
            placeholder="Search skills..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>
        <div className="tool-meta">
          {items.length} skill{items.length === 1 ? '' : 's'}
        </div>
      </div>

      {filteredItems.length === 0 ? (
        <div className="tool-empty">没有匹配的 Skill 条目</div>
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
                  <span className="tool-badge">{appLabel(item.appType)}</span>
                  {item.source === 'tool-manager' ? <span className="tool-badge">DB</span> : null}
                </div>
              </div>
              <p className="tool-card-desc">{item.description || 'No description'}</p>
              <div className="tool-card-badges">
                {item.tags.slice(0, 3).map((tag) => (
                  <span key={`${item.id}:${tag}`} className="tool-badge">
                    {tag}
                  </span>
                ))}
              </div>
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
            <h3>{editing.mode === 'create' ? 'Add New Skill' : 'Edit Skill'}</h3>
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
              <label>Skill 名称</label>
              <input
                type="text"
                value={editing.name}
                onChange={(event) => setEditing((prev) => (prev ? { ...prev, name: event.target.value } : prev))}
                placeholder="code-review"
              />
            </div>
            <div className="form-group">
              <label>Skill JSON</label>
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

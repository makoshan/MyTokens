import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { AppIntegration } from '../types/settings'
import './OpencodeToolsManager.css'

interface IntegrationConfigSnapshot {
  app_type: string
  config_path: string
  config: unknown
}

interface MykeyCapability {
  id: string
  description: string
  requires_master_password: boolean
  mutating: boolean
  params: string[]
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

interface SkillTemplate {
  name: string
  description: string
  content: Record<string, unknown>
}

interface SkillExportItem {
  appType: string
  skillKey: 'skill' | 'skills'
  name: string
  content: Record<string, unknown>
}

interface SkillExportBundle {
  version: number
  exportedAt: string
  items: SkillExportItem[]
}

const DEFAULT_SKILL_TEMPLATES: SkillTemplate[] = [
  {
    name: 'code-review',
    description: '通用代码审查，输出高置信度风险清单和修复建议',
    content: {
      description: '请对给定代码进行高优先级问题识别：安全、性能、可维护性，并按优先级给出可执行修复步骤。',
      tags: ['review', 'quality', 'security'],
    },
  },
  {
    name: 'bug-surgeon',
    description: '定位错误日志中的根因并给出修复步骤',
    content: {
      description: '请聚焦日志片段，先给出可能根因，再给出最小改动修复方案和验证命令。',
      tags: ['debug', 'bug', 'triage'],
    },
  },
  {
    name: 'release-notes',
    description: '将变更自动整理为发布说明',
    content: {
      description: '请将输入变更提炼为功能点、风险点、回归建议，输出标准发布说明格式。',
      tags: ['documentation', 'release', 'summary'],
    },
  },
]

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

function normalizeExportObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 需要 JSON 对象`)
  }
  return value as Record<string, unknown>
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

function parseSkillExportBundle(raw: string): SkillExportBundle {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`导入文件不是有效 JSON：${String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('导入内容不是对象')
  }
  const payload = parsed as { [key: string]: unknown }
  const itemsRaw = Array.isArray(payload.items) ? payload.items : []
  const normalizedItems: SkillExportItem[] = []

  for (const item of itemsRaw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const candidate = item as Record<string, unknown>
    const appType = typeof candidate.appType === 'string' ? candidate.appType.trim() : ''
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : ''
    const skillKey = candidate.skillKey === 'skill' || candidate.skillKey === 'skills' ? candidate.skillKey : 'skills'
    const content = normalizeExportObject(candidate.content, `${appType}:${name}`)
    if (!appType || !name) continue
    normalizedItems.push({
      appType,
      skillKey,
      name,
      content,
    })
  }

  return {
    version: typeof payload.version === 'number' ? payload.version : 1,
    exportedAt: typeof payload.exportedAt === 'string' ? payload.exportedAt : new Date().toISOString(),
    items: normalizedItems,
  }
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
  const [capabilities, setCapabilities] = useState<MykeyCapability[]>([])
  const [showCapabilities, setShowCapabilities] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [templateAppType, setTemplateAppType] = useState('opencode')
  const fileInputRef = useRef<HTMLInputElement>(null)

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

      try {
        const capabilitiesResult = await invoke<MykeyCapability[]>('mykey_capabilities')
        setCapabilities(capabilitiesResult)
      } catch (err) {
        console.error('load mykey capabilities failed', err)
        setCapabilities([])
      }

      setIntegrations(visible)
      if (visible.length > 0 && !visible.some((item) => item.app_type === templateAppType)) {
        setTemplateAppType(visible[0].app_type)
      }
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

  const generateExportBundle = (nextItems: SkillItem[]): SkillExportBundle => {
    const integrationItems = nextItems
      .filter((item) => item.source === 'integration')
      .map((item) => {
        let content: Record<string, unknown>
        try {
          content = parseJsonObject(item.name, item.content)
        } catch (error) {
          throw new Error(`导出项 ${item.appType}/${item.name} 不是合法 JSON: ${String(error)}`)
        }

        return {
          appType: item.appType,
          skillKey: item.skillKey,
          name: item.name,
          content,
        }
      })

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      items: integrationItems,
    }
  }

  const handleExportSkills = () => {
    const bundle = generateExportBundle(items)
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: 'application/json; charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `mykey-skills-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const applyImportedSkills = async (bundle: SkillExportBundle) => {
    const sourceItems = items.filter((item) => item.source === 'integration')
    const appUpdates: Record<string, SkillItem[]> = {}
    const insertedNames = new Set<string>()

    for (const incoming of bundle.items) {
      const snapshot = snapshotsByApp[incoming.appType]
      if (!snapshot) {
        continue
      }

      const parsed = normalizeExportObject(incoming.content, `${incoming.appType}:${incoming.name}`)
      const meta = extractSkillMeta(parsed)
      const nextItem: SkillItem = {
        id: randomId(),
        appType: incoming.appType,
        configPath: snapshot.config_path,
        source: 'integration',
        skillKey: incoming.skillKey,
        name: incoming.name,
        content: formatJson(parsed),
        tags: meta.tags,
        description: meta.description,
      }

      appUpdates[incoming.appType] = appUpdates[incoming.appType]
        ? [...appUpdates[incoming.appType], nextItem]
        : [nextItem]
      insertedNames.add(`${incoming.appType}::${incoming.name}`)
    }

    const updatedItems: SkillItem[] = [...items.filter((item) => item.source === 'tool-manager')]
    const appTypes = new Set<string>([
      ...Object.keys(snapshotsByApp),
      ...Object.keys(appUpdates),
    ])

    for (const appType of appTypes) {
      const snapshot = snapshotsByApp[appType]
      if (!snapshot) {
        continue
      }
      const existing = sourceItems.filter((item) => item.appType === appType)
      const merged = new Map(existing.map((item) => [item.name, item] as [string, SkillItem]))
      const imported = appUpdates[appType] || []
      imported.forEach((item) => {
        merged.set(item.name, item)
      })
      const nextItems = [...merged.values()]
      await persistApp(appType, nextItems)
      updatedItems.push(...nextItems.filter((item) => item.appType === appType))
    }

    setItems(updatedItems)
    setNotice(`已导入 ${insertedNames.size} 个 Skill`)
  }

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const raw = await file.text()
      const bundle = parseSkillExportBundle(raw)
      if (!bundle.items.length) {
        alert('导入文件中没有可用 Skill')
        return
      }
      await applyImportedSkills(bundle)
    } catch (error) {
      alert(`导入失败: ${String(error)}`)
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const triggerImport = () => {
    if (!fileInputRef.current) return
    fileInputRef.current.click()
  }

  const applyTemplate = (template: SkillTemplate, appType: string) => {
    setEditing({
      mode: 'create',
      appType,
      name: template.name,
      content: formatJson({
        description: template.description,
        ...template.content,
      }),
    })
  }

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setNotice('已复制到剪贴板')
    } catch (err) {
      console.error('copy failed', err)
      alert('复制失败，请手动复制')
    }
  }

  const commandSignature = (capability: MykeyCapability) => {
    const params = capability.params.length ? capability.params.join(', ') : '无参数'
    return `${capability.id}(${params})`
  }

  const templateCount = integrations.length > 0 ? `${integrations.length} 个可用应用` : '0 个可用应用'

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
          <button className="btn btn-secondary" onClick={triggerImport}>
            导入技能
          </button>
          <button className="btn btn-secondary" onClick={handleExportSkills}>
            导出技能
          </button>
          <button className="btn btn-secondary" onClick={() => setShowTemplates((value) => !value)}>
            模板库
          </button>
          <button className="btn btn-secondary" onClick={() => setShowCapabilities((value) => !value)}>
            命令提示
          </button>
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

      {showTemplates ? (
        <section className="tool-panel">
          <div className="tool-panel-header">
            <h3>技能模板库（导入式）</h3>
            <div className="tool-panel-tools">
              <span className="tool-inline-label">应用到：</span>
              <select
                value={templateAppType}
                onChange={(event) => setTemplateAppType(event.target.value)}
                disabled={integrations.length === 0}
              >
                {integrations.map((integration) => (
                  <option key={integration.app_type} value={integration.app_type}>
                    {appLabel(integration.app_type)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="tool-panel-subtitle">{templateCount}，点击模板会打开编辑器，可直接保存。</p>
          <div className="tool-template-grid">
            {DEFAULT_SKILL_TEMPLATES.map((template) => {
              const snippet = JSON.stringify({ description: template.description, ...template.content }, null, 2)
              return (
                <article key={template.name} className="tool-card">
                  <h4>{template.name}</h4>
                  <p className="tool-card-desc">{template.description}</p>
                  <div className="tool-modal-actions">
                    <button
                      className="btn btn-secondary"
                      onClick={() => applyTemplate(template, templateAppType)}
                      disabled={integrations.length === 0}
                    >
                      应用到编辑器
                    </button>
                    <button className="btn btn-secondary" onClick={() => copyText(snippet)}>
                      复制内容
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      ) : null}

      {showCapabilities ? (
        <section className="tool-panel">
          <div className="tool-panel-header">
            <h3>命令提示面板</h3>
            <span className="tool-panel-subtitle">来自 mykey_capabilities，可配合 `$ mykey_command` 使用</span>
          </div>
          {capabilities.length === 0 ? (
            <div className="tool-empty">当前未获取到命令清单</div>
          ) : (
            <div className="tool-template-grid">
              {capabilities.map((capability) => (
                <article key={capability.id} className="tool-card">
                  <h4>{capability.id}</h4>
                  <p className="tool-card-desc">{capability.description}</p>
                  <p className="tool-badge" style={{ width: 'fit-content' }}>
                    {capability.requires_master_password ? '需要 Master Password' : '无需 Master Password'} /
                    {capability.mutating ? '可变更' : '只读'}
                  </p>
                  <div className="tool-card-badges" style={{ marginTop: 8 }}>
                    <code className="tool-inline-code">{commandSignature(capability)}</code>
                  </div>
                  {capability.params.length > 0 ? (
                    <ul className="tool-param-list">
                      {capability.params.map((item) => (
                        <li key={`${capability.id}:${item}`}>{item}</li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="tool-modal-actions">
                    <button
                      className="btn btn-secondary"
                      onClick={() =>
                        copyText(
                          JSON.stringify(
                            {
                              command: capability.id,
                              args: {},
                            },
                            null,
                            2,
                          ),
                        )
                      }
                    >
                      复制调用示例
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

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

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json"
        onChange={handleImportFile}
        style={{ display: 'none' }}
      />

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

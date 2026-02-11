import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import './ProjectManager.css'
import { getProviderDisplayName } from '../utils/provider'
import type { Project } from '../types/project'
import { getCredentialsLinkedToProject, resolveCredentialProjectName } from '../utils/linkage'

interface Credential {
  id: string
  provider: string
  name: string
  source?: string | null
}

interface ProjectManagerProps {
  credentials: Credential[]
  projects?: Project[]
  projectLabelsByCredential: Record<string, string>
  masterPassword: string
  onProjectsChanged?: (projects: Project[]) => void
  onError: (msg: string) => void
}

function projectAliases(project: Project) {
  const aliases = new Set<string>()
  const name = project.name.trim().toLowerCase()
  if (name) aliases.add(name)

  const normalizedPath = project.path.replace(/\\/g, '/')
  const parts = normalizedPath.split('/').filter(Boolean)
  const basename = parts[parts.length - 1]?.trim().toLowerCase()
  if (basename) aliases.add(basename)

  return aliases
}

export default function ProjectManager({
  credentials,
  projects: initialProjects = [],
  projectLabelsByCredential,
  masterPassword,
  onProjectsChanged,
  onError,
}: ProjectManagerProps) {
  const [projects, setProjects] = useState<Project[]>(initialProjects)
  const [loading, setLoading] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanStatus, setScanStatus] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [formName, setFormName] = useState('')
  const [formPath, setFormPath] = useState('')
  const [formCredId, setFormCredId] = useState('')

  useEffect(() => {
    initializeProjects()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masterPassword])

  useEffect(() => {
    setProjects(initialProjects)
  }, [initialProjects])

  async function initializeProjects() {
    if (!masterPassword) return
    await fetchProjects()
    await handleAutoScan(true)
  }

  async function fetchProjects() {
    if (!masterPassword) return
    setLoading(true)
    try {
      const data = await invoke<Project[]>('get_projects', { masterPassword })
      setProjects(data)
      onProjectsChanged?.(data)
    } catch (err) {
      onError('加载项目失败: ' + err)
    } finally {
      setLoading(false)
    }
  }

  function openAddModal() {
    setEditingProject(null)
    setFormName('')
    setFormPath('')
    setFormCredId('')
    setIsModalOpen(true)
  }

  function openEditModal(project: Project) {
    setEditingProject(project)
    setFormName(project.name)
    setFormPath(project.path)
    setFormCredId(project.credential_id || '')
    setIsModalOpen(true)
  }

  async function handleBrowse() {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
      })
      if (!selected || Array.isArray(selected)) return

      setFormPath(selected)
      if (!formName && !editingProject) {
        const parts = selected.split(/[/\\]/)
        const folderName = parts[parts.length - 1]
        if (folderName) setFormName(folderName)
      }
    } catch (err) {
      onError('打开目录选择失败: ' + err)
    }
  }

  async function handleSave() {
    if (!formName.trim() || !formPath.trim()) {
      onError('项目名称和路径不能为空')
      return
    }

    try {
      const credentialId = formCredId || null
      if (editingProject) {
        await invoke('update_project', {
          id: editingProject.id,
          name: formName.trim(),
          path: formPath.trim(),
          credentialId,
          masterPassword,
        })
      } else {
        await invoke('add_project', {
          name: formName.trim(),
          path: formPath.trim(),
          credentialId,
          masterPassword,
        })
      }
      setIsModalOpen(false)
      fetchProjects()
    } catch (err) {
      onError('保存项目失败: ' + err)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('确定要删除该项目吗？此操作不会删除本地文件。')) return

    try {
      await invoke('delete_project', { id, masterPassword })
      fetchProjects()
    } catch (err) {
      onError('删除项目失败: ' + err)
    }
  }

  async function handleOpenFolder(path: string) {
    try {
      await invoke('open_path', { path })
    } catch (err) {
      onError('打开目录失败: ' + err)
    }
  }

  async function handleAutoScan(silent = false) {
    if (!masterPassword) return
    setScanning(true)
    if (!silent) setScanStatus('')
    try {
      const added = await invoke<Project[]>('auto_scan_projects', { masterPassword })
      if (added.length > 0) {
        await fetchProjects()
      }
      if (silent) {
        if (added.length > 0) {
          setScanStatus(`自动扫描完成，已导入 ${added.length} 个项目`)
        }
      } else {
        setScanStatus(
          added.length > 0
            ? `自动扫描完成，新增 ${added.length} 个项目`
            : '自动扫描完成，没有发现新项目'
        )
      }
    } catch (err) {
      onError('自动扫描项目失败: ' + err)
    } finally {
      setScanning(false)
    }
  }

  const sourceGroups = useMemo(() => {
    const groups: Record<string, { label: string; credentials: Credential[]; sources: string[] }> = {}
    credentials.forEach((cred) => {
      const label = resolveCredentialProjectName(cred, projectLabelsByCredential, projects)
      const key = label.toLowerCase()
      if (!groups[key]) {
        groups[key] = {
          label,
          credentials: [],
          sources: [],
        }
      }
      groups[key].credentials.push(cred)
      if (cred.source && !groups[key].sources.includes(cred.source)) {
        groups[key].sources.push(cred.source)
      }
    })
    return groups
  }, [credentials, projectLabelsByCredential, projects])

  const managedAliasToProjectId = useMemo(() => {
    const aliases = new Map<string, string>()
    projects.forEach((project) => {
      projectAliases(project).forEach((alias) => aliases.set(alias, project.id))
    })
    return aliases
  }, [projects])

  const linkedCredentialsByManagedProject = useMemo(() => {
    const map: Record<string, Credential[]> = {}
    projects.forEach((project) => {
      map[project.id] = getCredentialsLinkedToProject(
        project,
        credentials,
        projectLabelsByCredential,
        projects
      )
    })
    return map
  }, [credentials, projectLabelsByCredential, projects])

  const sourceDerivedProjects = useMemo(() => {
    return Object.entries(sourceGroups)
      .filter(([alias]) => !managedAliasToProjectId.has(alias))
      .map(([alias, group]) => ({
        id: `source:${alias}`,
        name: group.label,
        path: group.sources[0] || '',
        credential_id: null,
        created_at: '',
        updated_at: '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [managedAliasToProjectId, sourceGroups])

  const displayedProjects = useMemo(() => {
    const merged = [...projects, ...sourceDerivedProjects]
    const q = searchQuery.trim().toLowerCase()
    if (!q) return merged
    return merged.filter((project) => {
      return project.name.toLowerCase().includes(q) || project.path.toLowerCase().includes(q)
    })
  }, [projects, searchQuery, sourceDerivedProjects])

  const getCredentialLabel = (id: string | null) => {
    if (!id) return '未绑定默认密钥'
    const cred = credentials.find((item) => item.id === id)
    if (!cred) return '已绑定密钥（已删除）'
    return `${cred.name} (${getProviderDisplayName(cred.provider)})`
  }

  return (
    <div className="projects-page">
      <div className="projects-toolbar">
        <div>
          <h2>项目管理</h2>
          <p>管理项目目录，并绑定默认密钥。会自动扫描 Claude 配置里的项目。</p>
        </div>
        <div className="projects-toolbar-actions">
          <input
            type="text"
            placeholder="搜索项目名称或路径"
            className="projects-search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button
            className="btn btn-secondary"
            onClick={() => handleAutoScan(false)}
            disabled={scanning}
          >
            {scanning ? '扫描中...' : '自动扫描'}
          </button>
          <button className="btn btn-primary" onClick={openAddModal}>
            + 添加项目
          </button>
        </div>
      </div>
      {scanStatus && <div className="projects-scan-status">{scanStatus}</div>}

      {loading ? (
        <div className="panel-loading">加载项目中...</div>
      ) : displayedProjects.length === 0 ? (
        <div className="panel-empty project-empty">
          <p>
            {projects.length === 0 && sourceDerivedProjects.length === 0
              ? '还没有项目，先添加一个项目目录。'
              : '没有匹配的项目。'}
          </p>
          {projects.length === 0 && sourceDerivedProjects.length === 0 && (
            <button className="btn btn-primary" onClick={openAddModal}>
              添加第一个项目
            </button>
          )}
        </div>
      ) : (
        <div className="projects-grid">
          {displayedProjects.map((project) => {
            const isSourceDerived = project.id.startsWith('source:')
            const alias = project.name.trim().toLowerCase()
            const linkedCredentials = isSourceDerived
              ? sourceGroups[alias]?.credentials || []
              : linkedCredentialsByManagedProject[project.id] || []
            const sourceCount = isSourceDerived ? sourceGroups[alias]?.sources.length || 0 : 0

            return (
            <article
              key={project.id}
              className={`project-card ${isSourceDerived ? 'source-derived' : ''}`}
            >
              <div className="project-card-header">
                <div>
                  <div className="project-title-row">
                    <h3>{project.name}</h3>
                    {isSourceDerived && <span className="project-source-badge">来源路径</span>}
                  </div>
                  {isSourceDerived ? (
                    <div className="project-path-text" title={project.path}>
                      {project.path}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="project-path-btn"
                      title={project.path}
                      onClick={() => handleOpenFolder(project.path)}
                    >
                      {project.path}
                    </button>
                  )}
                </div>
                {!isSourceDerived && (
                  <div className="project-card-actions">
                    <button
                      type="button"
                      className="btn btn-secondary project-action-btn"
                      onClick={() => openEditModal(project)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary project-action-btn danger"
                      onClick={() => handleDelete(project.id)}
                    >
                      删除
                    </button>
                  </div>
                )}
              </div>

              <div className="project-meta">
                <span className="project-meta-label">默认密钥</span>
                <span className="project-meta-value">
                  {isSourceDerived
                    ? `由来源路径推断${sourceCount > 1 ? `（${sourceCount} 条来源）` : ''}`
                    : getCredentialLabel(project.credential_id)}
                </span>
              </div>

              <div className="project-meta">
                <span className="project-meta-label">
                  关联密钥 ({linkedCredentials.length})
                </span>
                {linkedCredentials.length ? (
                  <div className="project-linked-list">
                    {linkedCredentials.slice(0, 4).map((cred) => (
                      <span key={cred.id} className="project-linked-item" title={cred.name}>
                        {cred.name}
                      </span>
                    ))}
                    {linkedCredentials.length > 4 && (
                      <span className="project-linked-item muted">
                        +{linkedCredentials.length - 4}
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="project-meta-value muted">暂无关联密钥</span>
                )}
              </div>

              {!isSourceDerived && (
                <div className="project-footer">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => handleOpenFolder(project.path)}
                  >
                    打开目录
                  </button>
                </div>
              )}
            </article>
            )
          })}
        </div>
      )}

      {isModalOpen && (
        <div className="modal-overlay" onClick={() => setIsModalOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editingProject ? '编辑项目' : '添加项目'}</h2>
              <button className="modal-close" onClick={() => setIsModalOpen(false)}>
                ✕
              </button>
            </div>

            <div className="modal-body">
              <div className="form-group">
                <label htmlFor="project-path">项目路径</label>
                <div className="project-path-row">
                  <input
                    id="project-path"
                    type="text"
                    value={formPath}
                    onChange={(e) => setFormPath(e.target.value)}
                    placeholder="/Users/xxx/my-project"
                  />
                  <button type="button" className="btn btn-secondary" onClick={handleBrowse}>
                    浏览
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="project-name">项目名称</label>
                <input
                  id="project-name"
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="例如：my-awesome-app"
                />
              </div>

              <div className="form-group">
                <label htmlFor="project-credential">默认密钥（可选）</label>
                <select
                  id="project-credential"
                  value={formCredId}
                  onChange={(e) => setFormCredId(e.target.value)}
                >
                  <option value="">未绑定</option>
                  {credentials.map((cred) => (
                    <option key={cred.id} value={cred.id}>
                      {cred.name} ({cred.provider})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setIsModalOpen(false)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={handleSave}>
                {editingProject ? '保存修改' : '创建项目'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

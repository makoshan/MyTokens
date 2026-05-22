import { useEffect, useMemo, useState } from 'react'
import './KeyList.css'
import {
  getProviderColor as getProviderColorById,
  getProviderDisplayName,
} from '../utils/provider'
import type { Project } from '../types/project'
import { resolveCredentialProjectName, UNMATCHED_PROJECT_NAME } from '../utils/linkage'
import { normalizeProjectLabel } from '../utils/project'

interface Credential {
  id: string
  provider: string
  name: string
  key: string
  created_at: string
  is_active: boolean
  source?: string | null
}

interface KeyListProps {
  credentials: Credential[]
  projects: Project[]
  projectLabelsByCredential?: Record<string, string>
  selectedKey: Credential | null
  onSelectKey: (key: Credential) => void
  onEditKey: (key: Credential) => void
  onDeleteKey: (id: string) => void
  onCopyKey?: (key: Credential) => void
  copiedKeyId?: string | null
  onNavigateToProvider?: (providerId: string) => void
  onNavigateToProject?: (projectName: string) => void
}

type GroupMode = 'provider' | 'project'

const PROJECT_COLORS = ['#f97316', '#0ea5e9', '#16a34a', '#db2777', '#7c3aed', '#2563eb']

const GROUP_MODE_STORAGE_KEY = 'mykey.keys.groupMode'

function hashText(input: string) {
  let hash = 0
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

export default function KeyList({
  credentials,
  projects,
  projectLabelsByCredential = {},
  selectedKey,
  onSelectKey,
  onEditKey,
  onDeleteKey,
  onCopyKey,
  copiedKeyId = null,
  onNavigateToProvider,
  onNavigateToProject,
}: KeyListProps) {
  const [groupMode, setGroupMode] = useState<GroupMode>('provider')
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    const saved = localStorage.getItem(GROUP_MODE_STORAGE_KEY)
    if (saved === 'provider' || saved === 'project') {
      setGroupMode(saved)
    }
  }, [])

  const updateGroupMode = (mode: GroupMode) => {
    setGroupMode(mode)
    localStorage.setItem(GROUP_MODE_STORAGE_KEY, mode)
  }

  const getProviderColor = (provider: string) => {
    return getProviderColorById(provider.toLowerCase())
  }

  const getProjectColor = (project: string) => {
    return PROJECT_COLORS[hashText(project) % PROJECT_COLORS.length]
  }

  const filteredCredentials = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase()
    if (!keyword) return credentials
    return credentials.filter((cred) => {
      const projectName = resolveCredentialProjectName(cred, projectLabelsByCredential, projects)
      const source = cred.source || ''
      const haystack = `${cred.name} ${cred.provider} ${projectName} ${source}`
      return haystack.toLowerCase().includes(keyword)
    })
  }, [credentials, projectLabelsByCredential, projects, searchQuery])

  const groupedKeys = useMemo(() => {
    const bucket = filteredCredentials.reduce(
      (acc, cred) => {
        if (groupMode === 'provider') {
          const key = cred.provider
          if (!acc[key]) {
            acc[key] = []
          }
          acc[key].push(cred)
          return acc
        }

        const resolved = resolveCredentialProjectName(cred, projectLabelsByCredential, projects)
        if (!acc[resolved]) {
          acc[resolved] = []
        }
        acc[resolved].push(cred)
        return acc
      },
      {} as Record<string, Credential[]>
    )

    const entries = Object.entries(bucket)
    if (groupMode === 'provider') {
      return entries.sort(([a], [b]) => a.localeCompare(b))
    }

    return entries.sort(([a], [b]) => {
      if (a === UNMATCHED_PROJECT_NAME) return 1
      if (b === UNMATCHED_PROJECT_NAME) return -1
      return a.localeCompare(b)
    })
  }, [filteredCredentials, groupMode, projectLabelsByCredential, projects])

  const hasProjectSource = credentials.some((cred) => {
    const manualLabel = normalizeProjectLabel(projectLabelsByCredential[cred.id])
    return !!manualLabel || !!cred.source?.trim()
  })

  const getGroupColor = (groupName: string) => {
    if (groupMode === 'provider') {
      return getProviderColor(groupName)
    }
    return getProjectColor(groupName)
  }

  const groupTitlePrefix = groupMode === 'provider' ? '' : '项目：'

  return (
    <div className="key-list">
      <div className="key-list-toolbar">
        <input
          className="key-list-search"
          type="text"
          placeholder="搜索名称、提供商、项目、来源"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
        />
        <div className="group-mode-switch">
          <button
            type="button"
            className={`group-mode-btn ${groupMode === 'provider' ? 'active' : ''}`}
            onClick={() => updateGroupMode('provider')}
          >
            按提供商
          </button>
          <button
            type="button"
            className={`group-mode-btn ${groupMode === 'project' ? 'active' : ''}`}
            onClick={() => updateGroupMode('project')}
          >
            按项目
          </button>
        </div>
        {groupMode === 'project' && (
          <div className="group-mode-hint">
            {hasProjectSource ? '优先匹配项目管理中的项目，未命中归入“未匹配项目”' : '当前没有可识别的项目信息'}
          </div>
        )}
        <div className="group-mode-hint">共 {filteredCredentials.length} 条密钥</div>
      </div>

      {groupedKeys.length === 0 ? (
        <div className="key-list-empty">没有匹配的密钥</div>
      ) : groupedKeys.map(([group, keys]) => (
        <div key={group} className="provider-group">
          <div className="provider-header">
            {groupMode === 'provider' && onNavigateToProvider ? (
              <button
                type="button"
                className="provider-badge provider-badge-btn"
                style={{ backgroundColor: getGroupColor(group) }}
                onClick={() => onNavigateToProvider(group)}
                title="跳转到提供商页"
              >
                {group.toUpperCase()}
              </button>
            ) : groupMode === 'project' && onNavigateToProject && group !== UNMATCHED_PROJECT_NAME ? (
              <button
                type="button"
                className="provider-badge provider-badge-btn"
                style={{ backgroundColor: getGroupColor(group) }}
                onClick={() => onNavigateToProject(group)}
                title="跳转到项目页"
              >
                {`${groupTitlePrefix}${group}`}
              </button>
            ) : (
              <span className="provider-badge" style={{ backgroundColor: getGroupColor(group) }}>
                {groupMode === 'provider' ? group.toUpperCase() : `${groupTitlePrefix}${group}`}
              </span>
            )}
            <span className="provider-count">{keys.length}</span>
          </div>
          <div className="keys-group">
            {keys.map((key) => (
              <div
                key={key.id}
                className={`key-item ${selectedKey?.id === key.id ? 'selected' : ''} ${
                  !key.is_active ? 'inactive' : ''
                }`}
                onClick={() => onSelectKey(key)}
              >
                <div className="key-item-content">
                  <div className="key-item-title-row">
                    <div className="key-item-name">{key.name}</div>
                    {!key.is_active ? <span className="key-item-status">已停用</span> : null}
                  </div>
                  <div className="key-item-preview">
                    {key.key.substring(0, 20)}...
                  </div>
                  {groupMode === 'project' && (
                    <div className="key-item-meta">
                      {onNavigateToProvider ? (
                        <button
                          type="button"
                          className="key-provider-tag key-provider-tag-btn"
                          onClick={(event) => {
                            event.stopPropagation()
                            onNavigateToProvider(key.provider)
                          }}
                          title="跳转到提供商页"
                        >
                          {getProviderDisplayName(key.provider)}
                        </button>
                      ) : (
                        <span className="key-provider-tag">{getProviderDisplayName(key.provider)}</span>
                      )}
                      {key.source && <span className="key-source-path">{key.source}</span>}
                    </div>
                  )}
                </div>
                <div className="key-item-actions">
                  <button
                    className="action-btn copy-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      onCopyKey?.(key)
                    }}
                    title="复制密钥"
                  >
                    {copiedKeyId === key.id ? '✅' : '📋'}
                  </button>
                  <button
                    className="action-btn edit-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      onEditKey(key)
                    }}
                    title="编辑"
                  >
                    ✏️
                  </button>
                  <button
                    className="action-btn delete-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteKey(key.id)
                    }}
                    title="删除"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

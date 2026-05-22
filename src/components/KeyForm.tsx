import { useState, useEffect } from 'react'
import './KeyForm.css'
import type { ProviderConfig } from '../types/provider'
import { buildProviderSelectGroups } from '../utils/provider'

interface Credential {
  id: string
  provider: string
  name: string
  key: string
  created_at: string
  is_active: boolean
}

interface KeyFormProps {
  credential?: Credential | null
  initialProjectLabel?: string
  providers: ProviderConfig[]
  onSave: (provider: string, name: string, key: string, projectLabel?: string) => void
  onCancel: () => void
}

export default function KeyForm({
  credential,
  initialProjectLabel,
  providers,
  onSave,
  onCancel,
}: KeyFormProps) {
  const initialProvider = credential?.provider || providers[0]?.provider || 'openai'
  const [provider, setProvider] = useState(initialProvider)
  const [name, setName] = useState(credential?.name || '')
  const [key, setKey] = useState(credential?.key || '')
  const [projectLabel, setProjectLabel] = useState(initialProjectLabel || '')
  const [showKey, setShowKey] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    setProvider(credential?.provider || providers[0]?.provider || 'openai')
    setName(credential?.name || '')
    setKey(credential?.key || '')
    setProjectLabel(initialProjectLabel || '')
  }, [credential, initialProjectLabel, providers])

  const validate = () => {
    const newErrors: Record<string, string> = {}

    if (!provider.trim()) {
      newErrors.provider = 'Provider is required'
    }
    if (!name.trim()) {
      newErrors.name = 'Name is required'
    }
    if (!key.trim()) {
      newErrors.key = 'Key is required'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (validate()) {
      onSave(provider, name, key, projectLabel)
    }
  }

  const providerGroups = buildProviderSelectGroups(providers)
  const hasKnownProvider = providerGroups.some((group) =>
    group.options.some((item) => item.value === provider)
  )

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{credential ? '编辑密钥' : '添加密钥'}</h2>
          <button className="modal-close" onClick={onCancel}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body">
          <div className="form-group">
            <label htmlFor="provider">提供商</label>
            <select
              id="provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className={errors.provider ? 'error' : ''}
            >
              {!provider.trim() ? null : !hasKnownProvider ? (
                <option value={provider}>{provider}</option>
              ) : null}
              {providerGroups.length === 0 ? (
                <option value="openai">OpenAI</option>
              ) : null}
              {providerGroups.map((group) => (
                <optgroup key={group.category} label={group.label}>
                  {group.options.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {errors.provider && <span className="error-message">{errors.provider}</span>}
          </div>

          <div className="form-group">
            <label htmlFor="name">名称</label>
            <input
              id="name"
              type="text"
              placeholder="e.g., My OpenAI Key"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={errors.name ? 'error' : ''}
            />
            {errors.name && <span className="error-message">{errors.name}</span>}
          </div>

          <div className="form-group">
            <label htmlFor="project">项目（可选）</label>
            <input
              id="project"
              type="text"
              placeholder="e.g., my-web-app"
              value={projectLabel}
              onChange={(e) => setProjectLabel(e.target.value)}
            />
          </div>

          <div className="form-group">
            <div className="key-input-header">
              <label htmlFor="key">密钥</label>
              <button
                type="button"
                className="show-key-btn"
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
            <input
              id="key"
              type={showKey ? 'text' : 'password'}
              placeholder="sk-..."
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className={errors.key ? 'error' : ''}
            />
            {errors.key && <span className="error-message">{errors.key}</span>}
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onCancel}>
              取消
            </button>
            <button type="submit" className="btn btn-primary">
              {credential ? '更新' : '添加'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

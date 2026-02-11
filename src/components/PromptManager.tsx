import { useEffect, useMemo, useState } from 'react'
import './PromptManager.css'

export interface PromptTemplate {
  id: string
  title: string
  content: string
  model: string
  variables: string[]
  created_at: string
  updated_at: string
}

interface PromptManagerProps {
  prompts: PromptTemplate[]
  selectedPrompt: PromptTemplate | null
  onSelectPrompt: (prompt: PromptTemplate) => void
  onSavePrompt: (
    id: string | null,
    title: string,
    content: string,
    model: string,
    variables: string[]
  ) => Promise<void> | void
  onDeletePrompt: (id: string) => Promise<void> | void
  loading?: boolean
}

const MODEL_SUGGESTIONS = [
  'default',
  'gpt-4o-mini',
  'gpt-4.1',
  'claude-3.5-sonnet',
  'claude-3.5-haiku',
  'gemini-1.5-pro',
]

export default function PromptManager({
  prompts,
  selectedPrompt,
  onSelectPrompt,
  onSavePrompt,
  onDeletePrompt,
  loading,
}: PromptManagerProps) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [model, setModel] = useState('default')
  const [variables, setVariables] = useState<string[]>([])
  const [newVariable, setNewVariable] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (selectedPrompt) {
      setTitle(selectedPrompt.title)
      setContent(selectedPrompt.content)
      setModel(selectedPrompt.model || 'default')
      setVariables(selectedPrompt.variables || [])
      setNewVariable('')
    } else {
      setTitle('')
      setContent('')
      setModel('default')
      setVariables([])
      setNewVariable('')
    }
  }, [selectedPrompt])

  const isDirty = useMemo(() => {
    if (!selectedPrompt) {
      return title.trim() || content.trim()
    }
    return (
      title !== selectedPrompt.title ||
      content !== selectedPrompt.content ||
      model !== selectedPrompt.model ||
      variables.join('|') !== (selectedPrompt.variables || []).join('|')
    )
  }, [selectedPrompt, title, content, model, variables])

  const handleSave = async () => {
    if (!title.trim()) {
      alert('标题不能为空')
      return
    }
    if (!content.trim()) {
      alert('提示词不能为空')
      return
    }
    setSaving(true)
    try {
      await onSavePrompt(selectedPrompt?.id ?? null, title.trim(), content.trim(), model, variables)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="prompts-view">
      <section className="panel prompt-list-panel">
        <div className="panel-header">
          <h2>提示词库</h2>
          <span className="panel-count">{prompts.length}</span>
        </div>
        {loading ? (
          <div className="panel-loading">加载中...</div>
        ) : (
          <div className="prompt-list">
            {prompts.map((prompt) => (
              <button
                key={prompt.id}
                className={`prompt-row ${selectedPrompt?.id === prompt.id ? 'active' : ''}`}
                onClick={() => onSelectPrompt(prompt)}
              >
                <div>
                  <div className="prompt-title">{prompt.title}</div>
                  <div className="prompt-meta">
                    {prompt.model || 'default'} · {formatDate(prompt.updated_at)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="panel prompt-detail-panel">
        <div className="panel-header">
          <h2>{selectedPrompt ? '提示词详情' : '新建提示词'}</h2>
        </div>
        <div className="prompt-details">
          <div className="form-group">
            <label>ID</label>
            <input type="text" value={selectedPrompt?.id || '自动生成'} disabled />
          </div>
          <div className="form-group">
            <label>标题</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="form-group">
            <label>提示词</label>
            <textarea
              rows={8}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="在这里编写提示词"
            />
          </div>
          <div className="form-group">
            <label>模型</label>
            <input
              list="model-suggestions"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="default"
            />
            <datalist id="model-suggestions">
              {MODEL_SUGGESTIONS.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </div>
          <div className="form-group">
            <label>变量</label>
            <div className="variable-row">
              <input
                placeholder="例如 topic"
                value={newVariable}
                onChange={(e) => setNewVariable(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  const value = newVariable.trim()
                  if (!value) return
                  if (variables.includes(value)) {
                    setNewVariable('')
                    return
                  }
                  setVariables((prev) => [...prev, value])
                  setNewVariable('')
                }}
              >
                + 添加
              </button>
            </div>
            {variables.length === 0 ? (
              <div className="helper-text">暂无变量。</div>
            ) : (
              <div className="variable-tags">
                {variables.map((variable) => (
                  <span key={variable} className="variable-tag">
                    {variable}
                    <button
                      type="button"
                      onClick={() => setVariables((prev) => prev.filter((v) => v !== variable))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="prompt-actions">
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={!isDirty || saving}
            >
              {saving ? '保存中...' : '保存'}
            </button>
            {selectedPrompt && (
              <button
                className="btn btn-secondary"
                onClick={() => onDeletePrompt(selectedPrompt.id)}
              >
                删除
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

const formatDate = (value: string) => {
  if (!value) return '-'
  return new Date(value).toLocaleDateString()
}

import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { homeDir } from '@tauri-apps/api/path'
import './ImportModal.css'

interface ParsedKey {
  provider: string
  name: string
  key: string
  source?: string
  variable?: string
}

interface ImportModalProps {
  masterPassword: string
  onImport: (items: ParsedKey[]) => Promise<void> | void
  onCancel: () => void
}

type ImportMode = 'scan' | 'paste'

export default function ImportModal({ masterPassword, onImport, onCancel }: ImportModalProps) {
  const [mode, setMode] = useState<ImportMode>('scan')
  const [content, setContent] = useState('')
  const [results, setResults] = useState<ParsedKey[]>([])
  const [selected, setSelected] = useState<Record<number, boolean>>({})
  const [scanPath, setScanPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const defaultPathKey = 'mykey.scanPath'

  useEffect(() => {
    const next: Record<number, boolean> = {}
    results.forEach((_, index) => {
      next[index] = true
    })
    setSelected(next)
  }, [results])

  useEffect(() => {
    setResults([])
    setMessage(null)
    if (mode === 'paste') {
      setScanPath('')
    }
  }, [mode])

  useEffect(() => {
    if (mode !== 'scan') return
    if (scanPath.trim()) return

    const cached = localStorage.getItem(defaultPathKey)
    if (cached) {
      setScanPath(cached)
      return
    }

    homeDir()
      .then((dir) => {
        if (dir) {
          setScanPath(dir)
        }
      })
      .catch(() => undefined)
  }, [mode, scanPath])

  const selectedItems = useMemo(() => {
    return results.filter((_, index) => selected[index])
  }, [results, selected])

  const handleScan = async () => {
    setMessage(null)
    const dir = scanPath.trim()
    if (!dir) {
      setMessage('请输入要扫描的目录路径。')
      return
    }
    localStorage.setItem(defaultPathKey, dir)
    setLoading(true)
    try {
      const response = await invoke<ParsedKey[]>('scan_env_dir', {
        rootPath: dir,
        masterPassword,
      })
      setResults(response)
      if (response.length === 0) {
        setMessage('未找到可识别的 Key，请确认目录内存在 .env 文件。')
      }
    } catch (error) {
      console.error('Failed to scan env files:', error)
      setMessage(`扫描失败：${String(error)}`)
    } finally {
      setLoading(false)
    }
  }

  const handleParsePaste = async () => {
    if (!content.trim()) {
      setMessage('请粘贴 .env 内容。')
      return
    }
    setLoading(true)
    setMessage(null)
    try {
      const response = await invoke<ParsedKey[]>('parse_env_file', {
        content,
        masterPassword,
      })
      setResults(response)
      if (response.length === 0) {
        setMessage('没有识别到可用的 Key。')
      }
    } catch (error) {
      console.error('Failed to parse env content:', error)
      setMessage('解析失败，请检查内容格式。')
    } finally {
      setLoading(false)
    }
  }

  const handleImport = async () => {
    if (!selectedItems.length) {
      setMessage('请选择需要导入的 Key。')
      return
    }
    setLoading(true)
    try {
      await onImport(selectedItems)
    } finally {
      setLoading(false)
    }
  }

  const toggleSelectAll = () => {
    const allSelected = results.length > 0 && selectedItems.length === results.length
    const next: Record<number, boolean> = {}
    results.forEach((_, index) => {
      next[index] = !allSelected
    })
    setSelected(next)
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal-large" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>批量导入</h2>
          <button className="modal-close" onClick={onCancel}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="import-tabs">
            <button
              className={`import-tab ${mode === 'scan' ? 'active' : ''}`}
              onClick={() => setMode('scan')}
            >
              扫描目录
            </button>
            <button
              className={`import-tab ${mode === 'paste' ? 'active' : ''}`}
              onClick={() => setMode('paste')}
            >
              粘贴 .env
            </button>
          </div>

          {mode === 'scan' ? (
            <div className="import-section">
              <p className="import-desc">递归扫描项目目录，自动发现并解析 .env 文件。</p>
              <div className="scan-actions">
                <input
                  type="text"
                  className="scan-input"
                  placeholder="输入项目路径，例如 ~/project"
                  value={scanPath}
                  onChange={(e) => setScanPath(e.target.value)}
                />
                <button className="btn btn-primary" onClick={handleScan} disabled={loading}>
                  开始扫描
                </button>
              </div>
            </div>
          ) : (
            <div className="import-section">
              <p className="import-desc">粘贴 .env 文件内容，MyKey 会本地解析可识别的 Key。</p>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="OPENAI_API_KEY=sk-proj-..."
                className="import-textarea"
                rows={7}
              />
              <button className="btn btn-secondary" onClick={handleParsePaste} disabled={loading}>
                解析内容
              </button>
            </div>
          )}

          <div className="import-results">
            <div className="results-header">
              <div>
                <strong>识别结果</strong>
                <span className="results-count">{results.length} 个</span>
              </div>
              <button className="btn btn-link" onClick={toggleSelectAll} disabled={!results.length}>
                {selectedItems.length === results.length ? '取消全选' : '全选'}
              </button>
            </div>

            {results.length === 0 ? (
              <div className="results-empty">{message || '等待扫描或解析结果…'}</div>
            ) : (
              <div className="results-list">
                {results.map((item, index) => (
                  <label key={`${item.provider}-${index}`} className="result-item">
                    <input
                      type="checkbox"
                      checked={!!selected[index]}
                      onChange={() =>
                        setSelected((prev) => ({
                          ...prev,
                          [index]: !prev[index],
                        }))
                      }
                    />
                    <div>
                      <div className="result-title">{item.name}</div>
                      <div className="result-meta">
                        {item.provider.toUpperCase()} · {maskKey(item.key)}
                      </div>
                      {item.source && <div className="result-source">{item.source}</div>}
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>

          {message && results.length > 0 && <div className="import-message">{message}</div>}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onCancel} disabled={loading}>
            取消
          </button>
          <button className="btn btn-primary" onClick={handleImport} disabled={loading}>
            {loading ? '处理中...' : `导入 ${selectedItems.length} 个`}
          </button>
        </div>
      </div>
    </div>
  )
}

const maskKey = (value: string) => {
  if (!value) return ''
  if (value.length <= 12) return value
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

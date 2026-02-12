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

interface ShipkeyScanReport {
  parsed_keys: ParsedKey[]
  env_files: number
  env_vars: number
  workflow_files: string[]
  workflow_secrets: string[]
  missing_workflow_secrets: string[]
  wrangler_file?: string | null
  wrangler_projects: string[]
  wrangler_bindings: string[]
  package_dependencies: string[]
  shipkey_fields: string[]
  used_shipkey_config: boolean
}

interface ImportModalProps {
  masterPassword: string
  onImport: (items: ParsedKey[]) => Promise<void> | void
  onCancel: () => void
}

type ImportMode = 'scan' | 'paste'
type ExtendedImportMode = ImportMode | 'shipkey'

export default function ImportModal({ masterPassword, onImport, onCancel }: ImportModalProps) {
  const [mode, setMode] = useState<ExtendedImportMode>('scan')
  const [content, setContent] = useState('')
  const [results, setResults] = useState<ParsedKey[]>([])
  const [selected, setSelected] = useState<Record<number, boolean>>({})
  const [scanPath, setScanPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [shipkeyReport, setShipkeyReport] = useState<ShipkeyScanReport | null>(null)
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
    setShipkeyReport(null)
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
    setShipkeyReport(null)
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
    setShipkeyReport(null)
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

  const handleShipkeyScan = async () => {
    setMessage(null)
    const dir = scanPath.trim()
    if (!dir) {
      setMessage('请输入要迁移的项目目录路径。')
      return
    }
    localStorage.setItem(defaultPathKey, dir)
    setLoading(true)
    try {
      const report = await invoke<ShipkeyScanReport>('scan_shipkey_dir', {
        rootPath: dir,
        masterPassword,
      })
      setShipkeyReport(report)
      setResults(report.parsed_keys)
      if (report.parsed_keys.length === 0) {
        setMessage('未识别到可迁移的密钥值，请检查 .env/.dev.vars/shipkey.json。')
      } else {
        setMessage(
          `shipkey 扫描完成：发现 ${report.parsed_keys.length} 个可导入值，workflow secrets ${report.workflow_secrets.length} 个。`
        )
      }
    } catch (error) {
      console.error('Failed to scan shipkey project:', error)
      setShipkeyReport(null)
      setMessage(`扫描失败：${String(error)}`)
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
            <button
              className={`import-tab ${mode === 'shipkey' ? 'active' : ''}`}
              onClick={() => setMode('shipkey')}
            >
              ShipKey 迁移
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
          ) : mode === 'shipkey' ? (
            <div className="import-section">
              <p className="import-desc">
                按 shipkey 项目规则扫描（shipkey.json + workflow + wrangler + package.json），并迁移可导入密钥。
              </p>
              <div className="scan-actions">
                <input
                  type="text"
                  className="scan-input"
                  placeholder="输入 shipkey 项目路径，例如 ~/project"
                  value={scanPath}
                  onChange={(e) => setScanPath(e.target.value)}
                />
                <button className="btn btn-primary" onClick={handleShipkeyScan} disabled={loading}>
                  扫描并迁移
                </button>
              </div>
              {shipkeyReport && (
                <div className="shipkey-report">
                  <div className="shipkey-report-line">
                    <strong>Env:</strong> {shipkeyReport.env_files} 文件 / {shipkeyReport.env_vars} 变量
                  </div>
                  <div className="shipkey-report-line">
                    <strong>Workflow secrets:</strong> {shipkeyReport.workflow_secrets.length}
                    {shipkeyReport.missing_workflow_secrets.length > 0
                      ? `（缺失 ${shipkeyReport.missing_workflow_secrets.length}）`
                      : '（已覆盖）'}
                  </div>
                  <div className="shipkey-report-line">
                    <strong>Wrangler:</strong>{' '}
                    {shipkeyReport.wrangler_file
                      ? `${shipkeyReport.wrangler_file} / ${shipkeyReport.wrangler_projects.join(', ') || '无项目'}`
                      : '未检测'}
                  </div>
                  <div className="shipkey-report-line">
                    <strong>shipkey.json:</strong>{' '}
                    {shipkeyReport.used_shipkey_config
                      ? `已应用字段过滤（${shipkeyReport.shipkey_fields.length}）`
                      : '未检测到或未配置 providers.fields'}
                  </div>
                </div>
              )}
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

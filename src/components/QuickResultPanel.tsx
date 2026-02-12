import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import './QuickResultPanel.css'

interface QuickActionResult {
  action_type: string
  source_text?: string | null
  ocr_text?: string | null
  result_text?: string | null
  provider: string
  latency_ms: number
  status: string
  error_code?: string | null
  error_message?: string | null
  created_at: string
}

const QUICK_EVENT = 'quick_result_updated'
const AUTO_CLOSE_MS = 15_000

export default function QuickResultPanel() {
  const [result, setResult] = useState<QuickActionResult | null>(null)
  const [copied, setCopied] = useState<'source' | 'result' | null>(null)
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen<QuickActionResult>(QUICK_EVENT, (event) => {
      setResult(event.payload)
      setCopied(null)
      if (event.payload.status === 'success') {
        window.setTimeout(() => {
          invoke('hide_quick_result_panel').catch(() => undefined)
        }, AUTO_CLOSE_MS)
      }
    }).then((fn) => {
      unlisten = fn
    })

    invoke<QuickActionResult | null>('get_last_quick_action_result')
      .then((last) => {
        if (last) setResult(last)
      })
      .catch(() => undefined)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        invoke('hide_quick_result_panel').catch(() => undefined)
      }
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      if (unlisten) unlisten()
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const title = useMemo(() => {
    if (!result) return '快捷翻译'
    return result.action_type === 'ocr_translate' ? '截图翻译' : '划词翻译'
  }, [result])

  const copyText = async (type: 'source' | 'result', value: string | null | undefined) => {
    if (!value || !value.trim()) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(type)
      window.setTimeout(() => setCopied(null), 1500)
    } catch {
      // ignore
    }
  }

  const retry = async () => {
    if (retrying) return
    try {
      setRetrying(true)
      await invoke('retry_last_quick_action')
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="quick-result-window">
      <header className="quick-result-header">
        <div>
          <h1>{title}</h1>
          {result ? (
            <p>
              {result.provider} · {result.latency_ms}ms
            </p>
          ) : (
            <p>等待结果...</p>
          )}
        </div>
        <button
          type="button"
          className="quick-close-btn"
          onClick={() => invoke('hide_quick_result_panel').catch(() => undefined)}
        >
          关闭
        </button>
      </header>

      {!result ? (
        <section className="quick-result-body empty">按下快捷键开始翻译。</section>
      ) : result.status !== 'success' ? (
        <section className="quick-result-body error">
          <p className="quick-error-title">执行失败</p>
          <p>{result.error_message || '未知错误'}</p>
        </section>
      ) : (
        <section className="quick-result-body">
          {result.ocr_text ? (
            <article className="quick-result-block">
              <div className="quick-result-label">OCR 文本</div>
              <pre>{result.ocr_text}</pre>
            </article>
          ) : null}
          {result.source_text ? (
            <article className="quick-result-block">
              <div className="quick-result-label">原文</div>
              <pre>{result.source_text}</pre>
            </article>
          ) : null}
          <article className="quick-result-block">
            <div className="quick-result-label">译文</div>
            <pre>{result.result_text}</pre>
          </article>
        </section>
      )}

      <footer className="quick-result-footer">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => copyText('source', result?.ocr_text || result?.source_text)}
        >
          {copied === 'source' ? '已复制' : '复制原文'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => copyText('result', result?.result_text)}
        >
          {copied === 'result' ? '已复制' : '复制译文'}
        </button>
        <button type="button" className="btn btn-primary" onClick={retry}>
          {retrying ? '重试中...' : '重试'}
        </button>
      </footer>
    </div>
  )
}

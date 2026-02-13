import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { QuickActionResult, QuickProviderOptions } from '../types/settings'
import './QuickResultPanel.css'

const QUICK_EVENT = 'quick_result_updated'
const DEFAULT_AUTO_CLOSE_SECONDS = 15

export default function QuickResultPanel() {
  const [result, setResult] = useState<QuickActionResult | null>(null)
  const [providerOptions, setProviderOptions] = useState<QuickProviderOptions>({
    translate: [],
    ocr: [],
  })
  const [selectedTranslateProvider, setSelectedTranslateProvider] = useState('')
  const [selectedOcrProvider, setSelectedOcrProvider] = useState('')
  const [clippyText, setClippyText] = useState('')
  const [clippyError, setClippyError] = useState('')
  const [copied, setCopied] = useState<'source' | 'result' | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [clippyLoading, setClippyLoading] = useState(false)
  const [autoCloseSeconds, setAutoCloseSeconds] = useState(DEFAULT_AUTO_CLOSE_SECONDS)
  const hideTimerRef = useRef<number | null>(null)

  const isOcrMode = useMemo(() => {
    if (!result) return false
    return result.action_type === 'ocr_translate'
  }, [result])

  const sourceLabel = isOcrMode ? 'OCR 文本' : '原文'
  const sourceText = useMemo(() => {
    if (!result) return null
    return isOcrMode ? result.ocr_text || result.source_text || '' : result.source_text || ''
  }, [result, isOcrMode])

  const autoCloseMsRef = useRef(DEFAULT_AUTO_CLOSE_SECONDS * 1000)
  autoCloseMsRef.current = Math.max(3, autoCloseSeconds) * 1000

  const clearHideTimer = () => {
    if (hideTimerRef.current === null) return
    window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = null
  }

  useEffect(() => {
    invoke<number>('get_quick_action_auto_close_seconds')
      .then((seconds) => {
        const normalized = Number.isFinite(seconds) ? Math.max(3, Math.min(120, Number(seconds))) : DEFAULT_AUTO_CLOSE_SECONDS
        setAutoCloseSeconds(normalized || DEFAULT_AUTO_CLOSE_SECONDS)
      })
      .catch(() => {
        setAutoCloseSeconds(DEFAULT_AUTO_CLOSE_SECONDS)
      })

    invoke<QuickProviderOptions>('get_quick_provider_options')
      .then((options) => {
        setProviderOptions(options)
      })
      .catch(() => {
        setProviderOptions({ translate: [], ocr: [] })
      })

    invoke<QuickActionResult | null>('get_last_quick_action_result')
      .then((last) => {
        if (last) setResult(last)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | undefined

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        invoke('hide_quick_result_panel').catch(() => undefined)
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
        if (event.shiftKey) {
          copyText('source', sourceText)
        } else {
          copyText('result', result?.result_text)
        }
      }
    }

    listen<QuickActionResult>(QUICK_EVENT, (event) => {
      setResult(event.payload)
      setCopied(null)
      clearHideTimer()
      if (event.payload.status === 'success') {
        hideTimerRef.current = window.setTimeout(() => {
          invoke('hide_quick_result_panel').catch(() => undefined)
        }, autoCloseMsRef.current)
      }
    }).then((fn) => {
      unlisten = fn
    })

    window.addEventListener('keydown', onKeyDown)

    return () => {
      if (unlisten) unlisten()
      window.removeEventListener('keydown', onKeyDown)
      clearHideTimer()
    }
  }, [result, sourceText])

  useEffect(() => {
    const nextTranslateProvider = result?.translate_provider || result?.provider || ''
    const nextOcrProvider = result?.ocr_provider || ''

    if (!result) {
      setSelectedTranslateProvider(providerOptions.translate[0]?.provider || '')
      setSelectedOcrProvider(providerOptions.ocr[0]?.provider || '')
      return
    }

    setSelectedTranslateProvider(
      providerOptions.translate.some((item) => item.provider === nextTranslateProvider)
        ? nextTranslateProvider
        : providerOptions.translate[0]?.provider || ''
    )

    setSelectedOcrProvider(
      isOcrMode && providerOptions.ocr.some((item) => item.provider === nextOcrProvider)
        ? nextOcrProvider
        : isOcrMode
          ? providerOptions.ocr[0]?.provider || ''
          : ''
    )
  }, [providerOptions.translate, providerOptions.ocr, isOcrMode, result])

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
      await invoke('retry_last_quick_action', {
        preferred_translate_provider: selectedTranslateProvider || undefined,
        preferred_ocr_provider: isOcrMode ? selectedOcrProvider || undefined : undefined,
      })
    } finally {
      setRetrying(false)
    }
  }

  const askClippy = async () => {
    if (!result?.result_text || clippyLoading) return
    try {
      setClippyLoading(true)
      setClippyError('')
      setClippyText('')
      const payload = {
        translated_text: result.result_text,
        action_type: result.action_type,
        ...(sourceText ? { source_text: sourceText } : {}),
      }
      const answer = await invoke<string>('quick_clippy_assist', payload)
      setClippyText(answer)
    } catch (error) {
      setClippyError(String(error))
    } finally {
      setClippyLoading(false)
    }
  }

  const translateProviderDisabled = providerOptions.translate.length <= 0
  const ocrProviderDisabled = providerOptions.ocr.length <= 0
  const canRetry = !!result
  const canAskClippy = !!result && result.status === 'success'

  const providerBadge = useMemo(() => {
    if (!result) return '等待结果'
    const translateProvider = result.translate_provider || result.provider
    if (!isOcrMode) return `翻译：${translateProvider || '默认'}`
    const ocrProvider = result.ocr_provider || 'OCR'
    return `OCR：${ocrProvider} + 翻译：${translateProvider || '默认'}`
  }, [result, isOcrMode])

  return (
    <div className="quick-result-window">
      <header className="quick-result-header">
        <div>
          <h1>快捷翻译</h1>
          <p>
            {result ? `${providerBadge} · ${result.latency_ms}ms` : providerBadge}
          </p>
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
          {!!result.error_code ? <p className="quick-error-code">{result.error_code}</p> : null}
        </section>
      ) : (
        <section className="quick-result-body">
          <article className="quick-result-block">
            <div className="quick-result-label">{sourceLabel}</div>
            <pre>{sourceText || '（空）'}</pre>
          </article>
          <article className="quick-result-block">
            <div className="quick-result-label">译文</div>
            <pre>{result.result_text || '（无返回）'}</pre>
          </article>

          <article className="quick-result-block quick-provider-select-block">
            <div className="quick-result-label">翻译 Provider</div>
            <select
              className="quick-select"
              value={selectedTranslateProvider}
              onChange={(event) => setSelectedTranslateProvider(event.target.value)}
              disabled={translateProviderDisabled}
            >
              {providerOptions.translate.map((option) => (
                <option key={option.provider} value={option.provider}>
                  {option.label || option.provider}
                </option>
              ))}
            </select>
            {isOcrMode ? (
              <>
                <div className="quick-result-label quick-ocr-label">OCR Provider</div>
                <select
                  className="quick-select"
                  value={selectedOcrProvider}
                  onChange={(event) => setSelectedOcrProvider(event.target.value)}
                  disabled={ocrProviderDisabled}
                >
                  {providerOptions.ocr.map((option) => (
                    <option key={option.provider} value={option.provider}>
                      {option.label || option.provider}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
          </article>

          {clippyText ? (
            <article className="quick-result-block">
              <div className="quick-result-label">Clippy</div>
              <pre>{clippyText}</pre>
            </article>
          ) : null}
          {clippyError ? (
            <article className="quick-result-block quick-result-error">
              <div className="quick-result-label">Clippy 失败</div>
              <pre>{clippyError}</pre>
            </article>
          ) : null}
        </section>
      )}

      <footer className="quick-result-footer">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => copyText('source', sourceText)}
          disabled={!result}
        >
          {copied === 'source' ? '已复制' : sourceLabel}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => copyText('result', result?.result_text)}
          disabled={!result}
        >
          {copied === 'result' ? '已复制' : '复制译文'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={askClippy}
          disabled={!canAskClippy || clippyLoading}
        >
          {clippyLoading ? '生成中...' : 'Clippy 建议'}
        </button>
        <button type="button" className="btn btn-primary" onClick={retry} disabled={!canRetry || retrying}>
          {retrying ? '重试中...' : '重试'}
        </button>
      </footer>
    </div>
  )
}

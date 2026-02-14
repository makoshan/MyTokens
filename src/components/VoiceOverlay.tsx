import { useEffect, useMemo, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import './VoiceOverlay.css'

type OverlayState = 'hidden' | 'recording' | 'transcribing' | 'processing' | 'done' | 'saved' | 'error'

interface OverlayPayload {
  state: OverlayState
  text?: string | null
}

const EVT = 'voice_overlay_update'

function clampText(raw: string, max = 48) {
  const text = raw.trim().replace(/\s+/g, ' ')
  if (text.length <= max) return text
  return `${text.slice(0, max)}...`
}

export default function VoiceOverlay() {
  const [visible, setVisible] = useState(false)
  const [state, setState] = useState<OverlayState>('hidden')
  const [text, setText] = useState<string>('')

  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen<OverlayPayload>(EVT, (event) => {
      const payload = event.payload
      const nextState = payload.state
      const nextText = payload.text ? clampText(payload.text) : ''
      setState(nextState)
      setText(nextText)
      setVisible(nextState !== 'hidden')
    }).then((fn) => {
      unlisten = fn
    })
    return () => {
      if (unlisten) unlisten()
    }
  }, [])

  const title = useMemo(() => {
    switch (state) {
      case 'recording':
        return '正在录音'
      case 'transcribing':
        return '识别中...'
      case 'processing':
        return '润色中...'
      case 'done':
        return '已转录'
      case 'saved':
        return '已保存'
      case 'error':
        return '失败'
      default:
        return ''
    }
  }, [state])

  return (
    <div className={`voice-overlay ${visible ? 'visible' : ''} ${state}`}>
      <div className="left">
        {state === 'recording' ? <div className="mic-dot" /> : null}
        {state === 'transcribing' || state === 'processing' ? <div className="spinner" /> : null}
        {state === 'done' || state === 'saved' ? <div className="check" /> : null}
        {state === 'error' ? <div className="xmark" /> : null}
      </div>
      <div className="middle">
        <div className="title">{title}</div>
        {state === 'recording' ? (
          <div className="bars" aria-hidden="true">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="bar" />
            ))}
          </div>
        ) : text ? (
          <div className="text">{text}</div>
        ) : (
          <div className="text subtle">
            {state === 'transcribing'
              ? '语音转文字中 · Esc 取消粘贴 · 再按触发键取消识别'
              : state === 'processing'
                ? 'AI 自动编辑中'
                : ''}
          </div>
        )}
      </div>
    </div>
  )
}

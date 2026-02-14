import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import QuickResultPanel from './components/QuickResultPanel'
import VoiceOverlay from './components/VoiceOverlay'
import './index.css'

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')

const renderFatal = (title: string, error: unknown) => {
  const root = document.getElementById('root')
  if (!root) return
  const detail =
    error instanceof Error
      ? `${error.message}\n${error.stack ?? ''}`
      : typeof error === 'string'
        ? error
        : JSON.stringify(error, null, 2)
  root.innerHTML = `
    <div style="font-family: ui-sans-serif, system-ui; padding: 32px; color: #1f2937;">
      <h1 style="font-size: 20px; margin-bottom: 12px;">${escapeHtml(title)}</h1>
      <p style="margin-bottom: 16px; color: #6b7280;">应用启动失败，请将以下错误反馈给开发者。</p>
      <pre style="white-space: pre-wrap; background: #fff7ed; border: 1px solid #fed7aa; padding: 16px; border-radius: 12px; color: #9a3412;">${escapeHtml(detail)}</pre>
    </div>
  `
}

window.addEventListener('error', (event) => {
  renderFatal('Runtime Error', event.error ?? event.message)
})

window.addEventListener('unhandledrejection', (event) => {
  renderFatal('Unhandled Promise Rejection', event.reason)
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {window.location.hash.startsWith('#/quick-result') ? (
      <QuickResultPanel />
    ) : window.location.hash.startsWith('#/voice-overlay') ? (
      <VoiceOverlay />
    ) : (
      <App />
    )}
  </React.StrictMode>,
)

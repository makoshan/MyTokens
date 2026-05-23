import { useEffect, useMemo, useState } from 'react'
import { sendChat } from '../api.js'
import {
  buildChatModelOptions,
  capabilityLabel,
  composeChatInput,
  friendlyError,
  type ChatCapabilityId,
} from '../chatHelpers.js'
import { formatMicroUsd } from '../dashboardViewModel.js'
import { Button } from '../token-ui.js'
import type { DashboardSnapshot } from '../types.js'

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  meta?: string
}

const CAPABILITIES: ChatCapabilityId[] = ['mcp', 'skills', 'knowledge']
const DEFAULT_CAPABILITIES: ChatCapabilityId[] = []

export function ChatPlayground({
  snapshot,
  onRefresh,
  onTopup,
}: {
  snapshot: DashboardSnapshot
  onRefresh?: () => void | Promise<void>
  onTopup?: () => void
}) {
  const models = useMemo(() => buildChatModelOptions(snapshot), [snapshot])

  const [model, setModel] = useState(() => models[0]?.model ?? '')
  const [prompt, setPrompt] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [enabledCapabilities, setEnabledCapabilities] = useState<ChatCapabilityId[]>(DEFAULT_CAPABILITIES)

  useEffect(() => {
    if (models.some((option) => option.model === model)) return
    setModel(models[0]?.model ?? '')
  }, [model, models])

  useEffect(() => {
    setEnabledCapabilities(DEFAULT_CAPABILITIES)
  }, [snapshot.account.id])

  const noModels = models.length === 0
  const canSend = !loading && Boolean(model) && prompt.trim().length > 0
  const selectedModel = models.find((option) => option.model === model)

  function toggleCapability(id: ChatCapabilityId) {
    setEnabledCapabilities((previous) =>
      previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]
    )
  }

  async function handleSend() {
    if (!canSend) return
    const userPrompt = prompt.trim()
    const assistantId = `assistant-${Date.now()}`
    setLoading(true)
    setError('')
    setPrompt('')
    setMessages((previous) => [
      ...previous,
      { id: `user-${Date.now()}`, role: 'user', content: userPrompt, meta: model },
    ])
    try {
      const result = await sendChat(model, composeChatInput(userPrompt, enabledCapabilities))
      // Per-turn token usage — concrete "it's working" feedback, since the $ cost
      // (~$0.0004/turn) is too small to move the 2-decimal balance display.
      const usage = (result.raw as { usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } })?.usage
      const tokens = usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0)
      const meta = [enabledCapabilities.map(capabilityLabel).join(' · '), tokens ? `${tokens} tokens` : '']
        .filter(Boolean)
        .join(' · ')
      setMessages((previous) => [
        ...previous,
        {
          id: assistantId,
          role: 'assistant',
          content: result.text || '(模型已响应，但未返回文本内容)',
          meta: meta || undefined,
        },
      ])
    } catch (caught) {
      setError(friendlyError(caught instanceof Error ? caught.message : String(caught)))
    } finally {
      setLoading(false)
      // Reserve/settle billing already moved the server balance — refresh so the
      // displayed balance reflects what this turn just spent (or refunded on error).
      void onRefresh?.()
    }
  }

  return (
    <div className="chat-playground">
      <div className="chat-toolbar" data-slot="card">
        <div>
          <div data-slot="card-description">在线测试 · 无需 API Key</div>
          <h2 data-slot="card-title">AI 对话</h2>
        </div>
        <label className="chat-model-picker">
          <span>模型</span>
          <select value={model} onChange={(event) => setModel(event.target.value)} disabled={loading || noModels}>
            {models.map((option) => (
              <option key={option.model} value={option.model}>
                {option.model}
              </option>
            ))}
          </select>
        </label>
        <div className="chat-balance">
          <span>余额</span>
          <div className="chat-balance-row">
            <strong>{formatMicroUsd(snapshot.balanceMicroUsd)}</strong>
            {onTopup && (
              <button type="button" className="chat-topup-btn" onClick={onTopup}>
                💳 充值
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="chat-surface" data-slot="card">
        {noModels ? (
          <p className="muted">运营者还没有给当前账户开通可用模型路由。领取红包后请联系运营者刷新或添加路由。</p>
        ) : (
          <>
            <div className="chat-route-note">
              <span>{selectedModel?.channelLabel ?? 'route'}</span>
              <strong>{selectedModel?.actualModel ?? model}</strong>
            </div>

            <div className="chat-thread" aria-live="polite">
              {messages.length === 0 ? (
                <div className="chat-empty">
                  <strong>开始一段测试对话</strong>
                  <span>选择模型后直接发送消息；MCP 与 Skills 可按需开启。</span>
                </div>
              ) : (
                messages.map((message) => (
                  <article key={message.id} className={`chat-message ${message.role}`}>
                    <div className="chat-message-meta">{message.role === 'user' ? '你' : model}</div>
                    <div className="chat-message-bubble">
                      <p>{message.content}</p>
                      {message.meta && <span>{message.meta}</span>}
                    </div>
                  </article>
                ))
              )}
              {loading && (
                <article className="chat-message assistant">
                  <div className="chat-message-meta">{model}</div>
                  <div className="chat-message-bubble">
                    <p>生成中...</p>
                  </div>
                </article>
              )}
            </div>

            {error && <p className="chat-error">{error}</p>}

            <div className="chat-composer">
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="问点什么..."
                rows={3}
                disabled={loading}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault()
                    void handleSend()
                  }
                }}
              />
              <div className="chat-composer-footer">
                <div className="chat-capabilities" aria-label="Chat capabilities">
                  {CAPABILITIES.map((id) => {
                    const enabled = enabledCapabilities.includes(id)
                    return (
                      <button
                        key={id}
                        type="button"
                        className={enabled ? 'enabled' : ''}
                        aria-pressed={enabled}
                        onClick={() => toggleCapability(id)}
                      >
                        {capabilityLabel(id)}
                      </button>
                    )
                  })}
                </div>
                <div className="chat-actions">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setMessages([])
                      setError('')
                      setEnabledCapabilities(DEFAULT_CAPABILITIES)
                    }}
                    disabled={loading || messages.length === 0}
                  >
                    新对话
                  </Button>
                  <Button onClick={() => void handleSend()} disabled={!canSend}>
                    {loading ? '生成中...' : '发送'}
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default ChatPlayground

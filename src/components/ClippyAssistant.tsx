import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './ClippyAssistant.css'
import type { ProviderUsageStatus } from '../types/usage'
import type {
  GatewayPolicySettings,
  GatewayTrafficMetrics,
  GlobalSettingsPayload,
} from '../types/settings'
import { getQuotaStatus } from '../utils/usage'
import ClippyAlert from '../assets/clippy/Alert.png'
import ClippyDefault from '../assets/clippy/Default.png'
import ClippyGreeting from '../assets/clippy/Greeting.png'
import ClippyThinking from '../assets/clippy/Thinking.png'
import ClippyWave from '../assets/clippy/Wave.png'
import ClippyIdleAtom from '../assets/clippy/IdleAtom.png'
import ClippyIdleEyeBrowRaise from '../assets/clippy/IdleEyeBrowRaise.png'
import ClippyIdleFingerTap from '../assets/clippy/IdleFingerTap.png'
import ClippyIdleHeadScratch from '../assets/clippy/IdleHeadScratch.png'
import ClippyIdleSideToSide from '../assets/clippy/IdleSideToSide.png'
import ClippyCheckingSomething from '../assets/clippy/CheckingSomething.png'
import ClippyGetAttention from '../assets/clippy/GetAttention.png'

type AssistantSeverity = 'critical' | 'warning' | 'info'
type AgentMode = 'codex' | 'fallback'

type AssistantAction =
  | { id: string; label: string; kind: 'navigate'; view: AssistantView }
  | { id: string; label: string; kind: 'set_breaker'; enabled: boolean }
  | { id: string; label: string; kind: 'set_budget'; amount: number | null }
  | { id: string; label: string; kind: 'refresh' }

type AssistantSuggestion = {
  id: string
  severity: AssistantSeverity
  title: string
  detail: string
  actions: AssistantAction[]
}

type AssistantMessage = {
  id: string
  role: 'assistant' | 'user'
  text: string
}

type AssistantView =
  | 'dashboard'
  | 'keys'
  | 'projects'
  | 'providers'
  | 'apps'
  | 'mcp'
  | 'skills'
  | 'prompts'
  | 'settings'

interface ClippyAssistantProps {
  masterPassword: string
  onNavigate: (view: AssistantView) => void
}

interface GatewayAccessCredentials {
  base_url: string
  api_key: string
}

interface MykeyCapability {
  id: string
  description: string
  requires_master_password: boolean
  mutating: boolean
  params: string[]
}

interface MykeyActionPlan {
  actions?: Array<{
    command?: string
    args?: Record<string, unknown>
    reason?: string
  }>
}

type SuggestedCommandStatus = 'pending' | 'running' | 'success' | 'failed'

interface SuggestedCommand {
  id: string
  command: string
  args: Record<string, unknown>
  reason: string
  mutating: boolean
  status: SuggestedCommandStatus
  resultText?: string
}

const ANALYZE_INTERVAL_MS = 5 * 60 * 1000
const TRAFFIC_WINDOW_MINUTES = 60
const CLIPPY_IDLE_GREET_MS = 3200
const CLIPPY_IDLE_WAIT_MS = 4200

type ClippyAnimationKey =
  | 'Alert'
  | 'CheckingSomething'
  | 'Default'
  | 'GetAttention'
  | 'Greeting'
  | 'IdleAtom'
  | 'IdleEyeBrowRaise'
  | 'IdleFingerTap'
  | 'IdleHeadScratch'
  | 'IdleSideToSide'
  | 'Thinking'
  | 'Wave'

const CLIPPY_ANIMATIONS: Record<ClippyAnimationKey, { src: string; length: number }> = {
  Alert: { src: ClippyAlert, length: 2400 },
  CheckingSomething: { src: ClippyCheckingSomething, length: 6640 },
  Default: { src: ClippyDefault, length: 0 },
  GetAttention: { src: ClippyGetAttention, length: 2650 },
  Greeting: { src: ClippyGreeting, length: 4450 },
  IdleAtom: { src: ClippyIdleAtom, length: 4500 },
  IdleEyeBrowRaise: { src: ClippyIdleEyeBrowRaise, length: 1500 },
  IdleFingerTap: { src: ClippyIdleFingerTap, length: 1150 },
  IdleHeadScratch: { src: ClippyIdleHeadScratch, length: 1900 },
  IdleSideToSide: { src: ClippyIdleSideToSide, length: 5700 },
  Thinking: { src: ClippyThinking, length: 4500 },
  Wave: { src: ClippyWave, length: 4900 },
}

const CLIPPY_IDLE_KEYS: ClippyAnimationKey[] = [
  'IdleAtom',
  'IdleEyeBrowRaise',
  'IdleFingerTap',
  'IdleHeadScratch',
  'IdleSideToSide',
  'CheckingSomething',
]

function summarizeCurrentSituation(
  policy: GatewayPolicySettings | null,
  traffic: GatewayTrafficMetrics | null
) {
  const requests = traffic?.total_requests ?? 0
  const rpm = traffic?.requests_per_minute ?? 0
  const success =
    traffic && traffic.total_requests > 0
      ? ((traffic.success_requests / traffic.total_requests) * 100).toFixed(1)
      : '100.0'
  const cost = policy?.today_cost_usd ?? 0
  const budget = policy?.daily_budget_usd
  const budgetText = budget ? `$${budget.toFixed(2)}` : '未设置'
  return `最近 1 小时请求 ${requests} 次（${rpm.toFixed(2)} req/min），成功率 ${success}%，今日成本 $${cost.toFixed(4)}，预算 ${budgetText}。`
}

function buildSuggestions(
  settings: GlobalSettingsPayload | null,
  policy: GatewayPolicySettings | null,
  traffic: GatewayTrafficMetrics | null,
  usageStatuses: ProviderUsageStatus[],
  runtimeGatewayOnline: boolean
): AssistantSuggestion[] {
  const suggestions: AssistantSuggestion[] = []
  const gatewayService = settings?.services.find((item) => item.service_name === 'gateway')

  if (!gatewayService?.enabled) {
    suggestions.push({
      id: 'gateway-disabled',
      severity: 'critical',
      title: '网关服务当前未启用',
      detail: '没有本地代理入口，后续流量分析和智能路由会失真。',
      actions: [{ id: 'goto-settings', label: '前往设置启用', kind: 'navigate', view: 'settings' }],
    })
  } else if (!gatewayService.running && !runtimeGatewayOnline) {
    suggestions.push({
      id: 'gateway-stopped',
      severity: 'critical',
      title: '网关已启用但未运行',
      detail: '请检查端口占用或配置错误，当前请求可能绕开统一代理。',
      actions: [
        { id: 'refresh-service', label: '刷新状态', kind: 'refresh' },
        { id: 'goto-settings', label: '检查服务配置', kind: 'navigate', view: 'settings' },
      ],
    })
  }

  if (traffic && traffic.total_requests >= 20) {
    const successRate = traffic.success_requests / traffic.total_requests
    if (successRate < 0.9) {
      suggestions.push({
        id: 'low-success-rate',
        severity: 'warning',
        title: '近 1 小时成功率偏低',
        detail: `成功率 ${(successRate * 100).toFixed(1)}%，建议检查上游稳定性并准备切换 provider。`,
        actions: [
          { id: 'goto-providers', label: '检查 Provider', kind: 'navigate', view: 'providers' },
          ...(!policy?.circuit_breaker_enabled
            ? [{ id: 'enable-breaker', label: '临时开启熔断', kind: 'set_breaker', enabled: true } as const]
            : []),
        ],
      })
    }

    if ((traffic.avg_latency_ms ?? 0) > 4500) {
      suggestions.push({
        id: 'high-latency',
        severity: 'warning',
        title: '平均延迟偏高',
        detail: `当前平均延迟约 ${Math.round(traffic.avg_latency_ms || 0)}ms，P95 ${
          traffic.p95_latency_ms ? `${traffic.p95_latency_ms}ms` : '--'
        }。`,
        actions: [
          { id: 'goto-providers-latency', label: '优化路由', kind: 'navigate', view: 'providers' },
        ],
      })
    }
  }

  if (policy) {
    if (!policy.daily_budget_usd && policy.today_cost_usd >= 1) {
      const suggestedBudget = Math.max(1, Number((policy.today_cost_usd * 1.3).toFixed(2)))
      suggestions.push({
        id: 'budget-missing',
        severity: 'info',
        title: '建议设置每日预算',
        detail: '检测到有实际成本支出，但未设置预算上限。',
        actions: [
          { id: 'set-budget', label: `设为 $${suggestedBudget}`, kind: 'set_budget', amount: suggestedBudget },
          { id: 'goto-settings-budget', label: '手动配置', kind: 'navigate', view: 'settings' },
        ],
      })
    } else if (
      policy.daily_budget_usd &&
      policy.daily_budget_usd > 0 &&
      policy.today_cost_usd / policy.daily_budget_usd >= 0.85
    ) {
      suggestions.push({
        id: 'budget-risk',
        severity: 'warning',
        title: '今日预算使用已接近上限',
        detail: `已使用 ${((policy.today_cost_usd / policy.daily_budget_usd) * 100).toFixed(1)}% 预算，建议提前做降载或切模型。`,
        actions: [{ id: 'goto-dashboard', label: '查看明细', kind: 'navigate', view: 'dashboard' }],
      })
    }
  }

  const criticalUsageProviders = usageStatuses
    .filter((status) => status.enabled && status.snapshot?.quotas?.length)
    .filter((status) => {
      const remaining = Math.min(...(status.snapshot?.quotas?.map((quota) => quota.percent_remaining) || [100]))
      const level = getQuotaStatus(remaining)
      return level === 'critical' || level === 'depleted'
    })

  if (criticalUsageProviders.length > 0) {
    suggestions.push({
      id: 'usage-critical',
      severity: 'warning',
      title: '部分 Provider 额度已告急',
      detail: `${criticalUsageProviders.map((item) => item.provider_id).join(' / ')} 出现低额度，请准备备用路线。`,
      actions: [{ id: 'goto-dashboard-usage', label: '查看用量看板', kind: 'navigate', view: 'dashboard' }],
    })
  }

  if (suggestions.length === 0) {
    suggestions.push({
      id: 'all-good',
      severity: 'info',
      title: '系统状态稳定',
      detail: '当前没有高优先级风险，建议维持现有策略并持续观察趋势。',
      actions: [{ id: 'refresh-all-good', label: '刷新分析', kind: 'refresh' }],
    })
  }

  return suggestions.sort((a, b) => severityScore(b.severity) - severityScore(a.severity))
}

function severityScore(level: AssistantSeverity) {
  if (level === 'critical') return 3
  if (level === 'warning') return 2
  return 1
}

function buildFallbackAnswer(
  question: string,
  policy: GatewayPolicySettings | null,
  traffic: GatewayTrafficMetrics | null,
  suggestions: AssistantSuggestion[]
) {
  const normalized = question.trim().toLowerCase()
  let answer = summarizeCurrentSituation(policy, traffic)

  if (normalized.includes('成本') || normalized.includes('预算')) {
    answer = `成本视角：${summarizeCurrentSituation(policy, traffic)} 我建议优先处理“${
      suggestions.find((item) => item.id.includes('budget'))?.title || '预算与成功率'
    }”。`
  } else if (normalized.includes('稳定') || normalized.includes('错误') || normalized.includes('延迟')) {
    answer = `稳定性视角：最近错误 Top 为 ${
      traffic?.top_errors?.map((item) => item.code).join(', ') || '无'
    }，平均延迟 ${traffic?.avg_latency_ms ? `${Math.round(traffic.avg_latency_ms)}ms` : '--'}。建议先看 Provider 分布并切到更稳定线路。`
  } else if (normalized.includes('下一步') || normalized.includes('建议')) {
    const top = suggestions
      .slice(0, 3)
      .map((item, index) => `${index + 1}. ${item.title}`)
      .join(' ')
    answer = `建议优先级：${top}`
  }

  return answer
}

function normalizeError(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function pickRandomIdleAnimation(previous?: ClippyAnimationKey) {
  const options = CLIPPY_IDLE_KEYS.filter((key) => key !== previous)
  const nextPool = options.length > 0 ? options : CLIPPY_IDLE_KEYS
  return nextPool[Math.floor(Math.random() * nextPool.length)]
}

function normalizeCodexAnswerForModelQuestion(
  question: string,
  answer: string,
  codexOnline: boolean
) {
  const q = question.trim().toLowerCase()
  const asksModel =
    q.includes('模型') ||
    q.includes('model') ||
    q.includes('用哪个') ||
    q.includes('最合适') ||
    q.includes('怎么选')

  if (!asksModel || !codexOnline) return answer
  if (answer.toLowerCase().includes('codex')) return answer

  return `当前你的网关链路已连通，首选模型应为 gpt-5-codex；只有在你明确要求极限省成本时，才考虑降级。\n${answer}`
}

function parseMykeyActionBlock(
  raw: string,
  capabilityMap: Record<string, MykeyCapability>
): { answerText: string; actions: SuggestedCommand[] } {
  const match = raw.match(/```mykey-actions\s*([\s\S]*?)```/i)
  if (!match) {
    return { answerText: raw.trim(), actions: [] }
  }

  const block = (match[1] || '').trim()
  let actions: SuggestedCommand[] = []
  try {
    const parsed = JSON.parse(block) as MykeyActionPlan
    const parsedActions = Array.isArray(parsed.actions) ? parsed.actions.slice(0, 3) : []
    actions = parsedActions
      .map((item, index) => {
        const command = (item.command || '').trim()
        if (!command || !capabilityMap[command]) return null
        const args = item.args && typeof item.args === 'object' ? item.args : {}
        return {
          id: `${Date.now()}-${index}`,
          command,
          args: args as Record<string, unknown>,
          reason: (item.reason || '').trim() || 'AI 建议执行',
          mutating: capabilityMap[command].mutating,
          status: 'pending' as SuggestedCommandStatus,
        }
      })
      .filter((item): item is SuggestedCommand => item !== null)
  } catch {
    actions = []
  }

  const cleaned = raw.replace(match[0], '').trim()
  return { answerText: cleaned, actions }
}

function formatCommandResult(result: unknown) {
  const raw = typeof result === 'string' ? result : JSON.stringify(result)
  if (!raw) return 'ok'
  return raw.length > 280 ? `${raw.slice(0, 280)}...` : raw
}

export default function ClippyAssistant({ masterPassword, onNavigate }: ClippyAssistantProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [settings, setSettings] = useState<GlobalSettingsPayload | null>(null)
  const [policy, setPolicy] = useState<GatewayPolicySettings | null>(null)
  const [traffic, setTraffic] = useState<GatewayTrafficMetrics | null>(null)
  const [usageStatuses, setUsageStatuses] = useState<ProviderUsageStatus[]>([])
  const [messages, setMessages] = useState<AssistantMessage[]>([
    {
      id: 'boot',
      role: 'assistant',
      text: '我是 Clippy，已开始监控你的 API 流量、成本和稳定性。',
    },
  ])
  const [askInput, setAskInput] = useState('')
  const [unread, setUnread] = useState(0)
  const [lastAnalyzedAt, setLastAnalyzedAt] = useState<Date | null>(null)
  const [agentMode, setAgentMode] = useState<AgentMode>('fallback')
  const [gatewayCreds, setGatewayCreds] = useState<GatewayAccessCredentials | null>(null)
  const [capabilities, setCapabilities] = useState<MykeyCapability[]>([])
  const [suggestedCommands, setSuggestedCommands] = useState<SuggestedCommand[]>([])
  const [agentError, setAgentError] = useState<string>('')
  const [greetingActive, setGreetingActive] = useState(true)
  const [avatarSrc, setAvatarSrc] = useState(CLIPPY_ANIMATIONS.Greeting.src)
  const signatureRef = useRef('')
  const openRef = useRef(open)
  const previousOpenRef = useRef(open)
  const previousSeverityRef = useRef<AssistantSeverity>('info')
  const idleAnimationRef = useRef<ClippyAnimationKey>()
  const clipTimeoutRef = useRef<number>()
  const idleTimeoutRef = useRef<number>()
  const runtimeGatewayOnline = agentMode === 'codex'
  const capabilityMap = useMemo(() => {
    const map: Record<string, MykeyCapability> = {}
    for (const item of capabilities) {
      map[item.id] = item
    }
    return map
  }, [capabilities])

  const suggestions = useMemo(
    () => buildSuggestions(settings, policy, traffic, usageStatuses, runtimeGatewayOnline),
    [policy, runtimeGatewayOnline, settings, traffic, usageStatuses]
  )

  const topSeverity = suggestions[0]?.severity || 'info'

  const addAssistantMessage = (text: string) => {
    setMessages((prev) => [...prev, { id: `${Date.now()}-${prev.length}`, role: 'assistant', text }])
  }

  const runAnalysis = async (silent = false) => {
    if (!masterPassword) return
    try {
      const [nextSettings, nextPolicy, nextTraffic, nextUsage] = await Promise.all([
        invoke<GlobalSettingsPayload>('get_global_settings', { masterPassword }),
        invoke<GatewayPolicySettings>('get_gateway_policy_settings', { masterPassword }),
        invoke<GatewayTrafficMetrics>('get_gateway_traffic_metrics', {
          windowMinutes: TRAFFIC_WINDOW_MINUTES,
          masterPassword,
        }),
        invoke<ProviderUsageStatus[]>('usage_get_summary'),
      ])

      setSettings(nextSettings)
      setPolicy(nextPolicy)
      setTraffic(nextTraffic)
      setUsageStatuses(nextUsage)
      setLastAnalyzedAt(new Date())

      const nextSuggestions = buildSuggestions(
        nextSettings,
        nextPolicy,
        nextTraffic,
        nextUsage,
        runtimeGatewayOnline
      )
      const signature = nextSuggestions.map((item) => `${item.id}:${item.severity}`).join('|')

      if (signature !== signatureRef.current) {
        signatureRef.current = signature
        if (!silent) {
          addAssistantMessage(
            `新分析完成：${nextSuggestions[0]?.title || '状态稳定'}。${summarizeCurrentSituation(nextPolicy, nextTraffic)}`
          )
        }
        if (!openRef.current) {
          const highPriority = nextSuggestions.filter((item) => item.severity !== 'info').length
          if (highPriority > 0) {
            setUnread((prev) => prev + highPriority)
          }
        }
      }
    } catch (error) {
      if (!silent) {
        addAssistantMessage(`分析失败：${normalizeError(error)}`)
      }
    }
  }

  const askByCodex = async (question: string) => {
    if (!gatewayCreds) throw new Error('Codex 网关凭证不可用')

    const riskTop = suggestions
      .slice(0, 3)
      .map((item, index) => `${index + 1}. [${item.severity}] ${item.title}: ${item.detail}`)
      .join('\n')
    const recentMsgs = messages
      .slice(-4)
      .map((item) => `${item.role === 'assistant' ? '助手' : '用户'}: ${item.text}`)
      .join('\n')
    const capabilityHints = capabilities
      .slice(0, 20)
      .map((item) => `- ${item.id}${item.params.length ? `(${item.params.join(', ')})` : ''}`)
      .join('\n')

    const systemPrompt = [
      '你是 MyKey 内置的 Clippy 助手。输出请简短、直接、可执行。',
      '你的主要目标是帮助用户降低 API 成本、提高稳定性、改善路由配置。',
      `当前网关状态: ${runtimeGatewayOnline ? '在线' : '离线'}`,
      '模型策略（强约束）：当前主链路是 Codex，本轮优先模型必须是 gpt-5-codex。',
      '如果用户问“现在用哪个模型最合适”，默认先给出 gpt-5-codex，再说明何时降级。',
      '除非用户明确要求极限省成本或低延迟，否则不要主动推荐 gpt-4o-mini / gpt-3.5。',
      '当网关在线时，不要建议“先检查端口并重启网关”。',
      `当前系统概览: ${summarizeCurrentSituation(policy, traffic)}`,
      '当前风险与建议:',
      riskTop || '暂无高优先级风险。',
      '如果用户提问不明确，优先给出接下来 1-3 步具体操作。',
      '你可以建议执行 mykey 命令。若建议执行，请在回复末尾附加一个代码块：',
      '```mykey-actions',
      '{"actions":[{"command":"gateway.status","args":{},"reason":"说明原因"}]}',
      '```',
      '只允许使用提供的能力命令，最多 3 条；若不需要执行则不要输出该代码块。',
      '可用命令:',
      capabilityHints || '- (无)',
      '默认使用中文回答。',
    ].join('\n')

    const richQuestion = `最近会话:\n${recentMsgs || '无'}\n\n用户问题: ${question}`
    return invoke<string>('clippy_codex_chat', {
      question: richQuestion,
      systemPrompt,
      model: 'gpt-5-codex',
      masterPassword,
    })
  }

  const askByText = async (question: string) => {
    const q = question.trim()
    if (!q || busy) return

    setMessages((prev) => [...prev, { id: `${Date.now()}-u`, role: 'user', text: q }])
    setAskInput('')
    setBusy(true)

    try {
      if (agentMode === 'codex' && gatewayCreds) {
        const rawAnswer = await askByCodex(q)
        const { answerText, actions } = parseMykeyActionBlock(rawAnswer, capabilityMap)
        const displayText =
          answerText ||
          (actions.length > 0 ? '已生成可执行操作建议，请按需一键执行。' : rawAnswer)
        const answer = normalizeCodexAnswerForModelQuestion(
          q,
          displayText,
          runtimeGatewayOnline
        )
        addAssistantMessage(answer)
        if (actions.length > 0) {
          setSuggestedCommands(actions)
          addAssistantMessage(`已生成 ${actions.length} 条可执行操作建议，可在下方一键执行。`)
        }
        setAgentError('')
      } else {
        addAssistantMessage(buildFallbackAnswer(q, policy, traffic, suggestions))
      }
    } catch (error) {
      const message = normalizeError(error)
      setAgentError(message)
      const fallback = buildFallbackAnswer(q, policy, traffic, suggestions)
      addAssistantMessage(`Codex 代理暂时不可用，已切换规则建议：${fallback}`)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => setGreetingActive(false), CLIPPY_IDLE_GREET_MS)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    const clearAnimationTimers = () => {
      if (clipTimeoutRef.current) {
        window.clearTimeout(clipTimeoutRef.current)
        clipTimeoutRef.current = undefined
      }
      if (idleTimeoutRef.current) {
        window.clearTimeout(idleTimeoutRef.current)
        idleTimeoutRef.current = undefined
      }
    }

    const playOneShot = (key: ClippyAnimationKey, settleToDefault = true) => {
      setAvatarSrc(CLIPPY_ANIMATIONS[key].src)
      if (!settleToDefault) return
      clipTimeoutRef.current = window.setTimeout(() => {
        setAvatarSrc(CLIPPY_ANIMATIONS.Default.src)
      }, CLIPPY_ANIMATIONS[key].length)
    }

    const playIdleLoop = () => {
      const nextIdle = pickRandomIdleAnimation(idleAnimationRef.current)
      idleAnimationRef.current = nextIdle
      setAvatarSrc(CLIPPY_ANIMATIONS[nextIdle].src)
      clipTimeoutRef.current = window.setTimeout(() => {
        setAvatarSrc(CLIPPY_ANIMATIONS.Default.src)
        const wait = CLIPPY_IDLE_WAIT_MS + Math.floor(Math.random() * 1800)
        idleTimeoutRef.current = window.setTimeout(playIdleLoop, wait)
      }, CLIPPY_ANIMATIONS[nextIdle].length)
    }

    clearAnimationTimers()

    if (greetingActive) {
      previousOpenRef.current = open
      previousSeverityRef.current = topSeverity
      setAvatarSrc(CLIPPY_ANIMATIONS.Greeting.src)
      return clearAnimationTimers
    }

    if (busy) {
      previousOpenRef.current = open
      previousSeverityRef.current = topSeverity
      setAvatarSrc(CLIPPY_ANIMATIONS.Thinking.src)
      return clearAnimationTimers
    }

    const justOpened = open && !previousOpenRef.current
    const justCritical = topSeverity === 'critical' && previousSeverityRef.current !== 'critical'
    previousOpenRef.current = open
    previousSeverityRef.current = topSeverity

    if (justOpened) {
      playOneShot('Wave')
      return clearAnimationTimers
    }

    if (justCritical && !open) {
      playOneShot('Alert')
      return clearAnimationTimers
    }

    if (open) {
      setAvatarSrc(CLIPPY_ANIMATIONS.GetAttention.src)
      return clearAnimationTimers
    }

    setAvatarSrc(CLIPPY_ANIMATIONS.Default.src)
    idleTimeoutRef.current = window.setTimeout(playIdleLoop, CLIPPY_IDLE_WAIT_MS)
    return clearAnimationTimers
  }, [busy, greetingActive, open, topSeverity])

  useEffect(() => {
    if (!masterPassword) return
    let canceled = false

    const bootstrapAgent = async () => {
      try {
        const caps = await invoke<MykeyCapability[]>('mykey_capabilities')
        if (!canceled) {
          setCapabilities(caps)
        }
      } catch {
        if (!canceled) {
          setCapabilities([])
        }
      }

      try {
        const creds = await invoke<GatewayAccessCredentials>('get_gateway_access_credentials', {
          appType: 'codex',
          masterPassword,
        })
        if (canceled) return
        setGatewayCreds(creds)
        setAgentMode('codex')
        setAgentError('')
      } catch (error) {
        if (canceled) return
        setGatewayCreds(null)
        setAgentMode('fallback')
        setAgentError(normalizeError(error))
      }
    }

    bootstrapAgent()
    return () => {
      canceled = true
    }
  }, [masterPassword])

  useEffect(() => {
    runAnalysis(true)
    const timer = window.setInterval(() => runAnalysis(true), ANALYZE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [masterPassword])

  useEffect(() => {
    openRef.current = open
  }, [open])

  useEffect(() => {
    if (open) setUnread(0)
  }, [open])

  const executeSuggestedCommand = async (id: string) => {
    const target = suggestedCommands.find((item) => item.id === id)
    if (!target || target.status === 'running') return
    if (target.mutating) {
      const confirmed = window.confirm(`该操作会修改配置：${target.command}\n是否继续执行？`)
      if (!confirmed) return
    }

    setSuggestedCommands((prev) =>
      prev.map((item) => (item.id === id ? { ...item, status: 'running' } : item))
    )

    try {
      const result = await invoke<unknown>('mykey_command', {
        command: target.command,
        args: target.args,
        masterPassword,
      })
      const resultText = formatCommandResult(result)
      setSuggestedCommands((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, status: 'success', resultText } : item
        )
      )
      addAssistantMessage(`已执行 ${target.command}：${resultText}`)
      await runAnalysis(true)
    } catch (error) {
      const message = normalizeError(error)
      setSuggestedCommands((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, status: 'failed', resultText: message } : item
        )
      )
      addAssistantMessage(`执行 ${target.command} 失败：${message}`)
    }
  }

  const executeAction = async (action: AssistantAction) => {
    try {
      setBusy(true)
      if (action.kind === 'navigate') {
        onNavigate(action.view)
        setOpen(false)
      } else if (action.kind === 'set_breaker') {
        await invoke('set_gateway_circuit_breaker', { enabled: action.enabled, masterPassword })
        addAssistantMessage(action.enabled ? '已开启全局熔断。' : '已关闭全局熔断。')
      } else if (action.kind === 'set_budget') {
        await invoke('set_gateway_daily_budget', {
          dailyBudgetUsd: action.amount,
          masterPassword,
        })
        addAssistantMessage(
          action.amount ? `已将每日预算设置为 $${action.amount.toFixed(2)}。` : '已清空每日预算。'
        )
      } else {
        await runAnalysis()
      }
      await runAnalysis(true)
    } catch (error) {
      addAssistantMessage(`执行失败：${normalizeError(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const onSubmitAsk = (event: FormEvent) => {
    event.preventDefault()
    askByText(askInput)
  }

  return (
    <div className="clippy-float-root">
      {open && (
        <section className="clippy-panel">
          <header className="clippy-panel-header">
            <div className="clippy-panel-title-wrap">
              <img src={avatarSrc} className="clippy-avatar-md" alt="Clippy" draggable={false} />
              <div>
                <h3>Clippy Assistant</h3>
                <p>{lastAnalyzedAt ? `最近分析：${lastAnalyzedAt.toLocaleTimeString()}` : '准备中...'}</p>
                <p className={`clippy-agent-status ${agentMode === 'codex' ? 'online' : 'offline'}`}>
                  {agentMode === 'codex' ? 'Codex 代理在线' : '规则模式（Codex 未连接）'}
                </p>
              </div>
            </div>
            <button className="clippy-close-btn" onClick={() => setOpen(false)}>
              关闭
            </button>
          </header>

          <div className="clippy-summary">
            <span className={`clippy-pill ${topSeverity}`}>{topSeverity.toUpperCase()}</span>
            <p>{summarizeCurrentSituation(policy, traffic)}</p>
            {agentError ? <p className="clippy-agent-error">模型连接提示：{agentError}</p> : null}
          </div>

          <div className="clippy-suggestions">
            {suggestions.slice(0, 4).map((item) => (
              <article key={item.id} className={`clippy-suggestion ${item.severity}`}>
                <div className="clippy-suggestion-title">{item.title}</div>
                <p>{item.detail}</p>
                <div className="clippy-action-row">
                  {item.actions.map((action) => (
                    <button
                      key={action.id}
                      className="btn btn-secondary"
                      onClick={() => executeAction(action)}
                      disabled={busy}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>

          {suggestedCommands.length > 0 && (
            <div className="clippy-tools">
              <div className="clippy-tools-title">AI 可执行建议</div>
              {suggestedCommands.slice(0, 4).map((item) => (
                <article key={item.id} className="clippy-tool-item">
                  <div className="clippy-tool-command">
                    <code>{item.command}</code>
                    {item.mutating && <span className="clippy-tool-tag">变更</span>}
                    <span className={`clippy-tool-status ${item.status}`}>{item.status}</span>
                  </div>
                  <p>{item.reason}</p>
                  {item.resultText ? <p className="clippy-tool-result">{item.resultText}</p> : null}
                  <div className="clippy-action-row">
                    <button
                      className="btn btn-secondary"
                      onClick={() => executeSuggestedCommand(item.id)}
                      disabled={busy || item.status === 'running'}
                    >
                      {item.status === 'running'
                        ? '执行中...'
                        : item.status === 'success'
                          ? '再次执行'
                          : '执行'}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}

          <div className="clippy-chat">
            <div className="clippy-chat-log">
              {messages.slice(-8).map((message) => (
                <div key={message.id} className={`clippy-msg ${message.role}`}>
                  {message.text}
                </div>
              ))}
            </div>
            <div className="clippy-quick-row">
              <button className="btn btn-secondary" onClick={() => askByText('给我成本建议')} disabled={busy}>
                成本建议
              </button>
              <button className="btn btn-secondary" onClick={() => askByText('现在稳定吗')} disabled={busy}>
                稳定性
              </button>
              <button className="btn btn-secondary" onClick={() => askByText('下一步我该做什么')} disabled={busy}>
                下一步
              </button>
            </div>
            <form className="clippy-ask-form" onSubmit={onSubmitAsk}>
              <input
                value={askInput}
                onChange={(event) => setAskInput(event.target.value)}
                placeholder="问 Clippy：比如“我现在最该优化什么？”"
              />
              <button className="btn btn-primary" type="submit" disabled={busy || !askInput.trim()}>
                {busy ? '思考中...' : '发送'}
              </button>
            </form>
          </div>
        </section>
      )}

      <button
        className={`clippy-fab ${open ? 'open' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        title="Clippy Assistant"
      >
        <img src={avatarSrc} className="clippy-avatar-sm" alt="Clippy" draggable={false} />
        {unread > 0 && <span className="clippy-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
    </div>
  )
}

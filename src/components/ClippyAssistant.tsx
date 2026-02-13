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

interface ClippySkill {
  name: string
  description: string | null
  tags: string[]
  prompt?: string
  boundModel?: string
  source?: 'builtin' | 'custom'
}

interface GatewayModelCatalogItem {
  app_type: string
  provider: string
  model: string
}

interface StoredClippySkill {
  name: string
  description: string
  tags: string[]
  prompt: string
  boundModel: string
}

interface PythonRunResult {
  ok: boolean
  python: string
  exit_code: number
  duration_ms: number
  stdout: string
  stderr: string
  structured_output?: unknown
}

interface ParsedDollarInvocation {
  kind: 'none' | 'python' | 'skill' | 'mykey'
  query: string
  code?: string
  timeoutMs?: number
  maxOutputChars?: number
  pythonArgs?: string[]
  skillName?: string
  skillPrompt?: string
  skillModel?: string
  mykeyCommand?: string
  mykeyArgs?: Record<string, unknown>
  error?: string
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

interface CommandRunResult {
  command: string
  ok: boolean
  resultText: string
}

const ANALYZE_INTERVAL_MS = 5 * 60 * 1000
const TRAFFIC_WINDOW_MINUTES = 60
const CLIPPY_IDLE_GREET_MS = 3200
const CLIPPY_IDLE_WAIT_MS = 4200
const AUTO_REMINDER_CHECK_MS = 60 * 1000
const AUTO_REMINDER_INTERVAL_MS = 12 * 60 * 1000
const AUTO_REMINDER_INTERVAL_MINUTES = Math.round(AUTO_REMINDER_INTERVAL_MS / (60 * 1000))
const AUTO_REMINDER_STORAGE_KEY = 'mykey.clippy.auto_remind_enabled'
const CLIPPY_ANIMATION_PROTOCOL_STORAGE_KEY = 'mykey.clippy.animation_protocol_enabled'
const CLIPPY_STYLE_PROMPT_STORAGE_KEY = 'mykey.clippy.style_prompt'
const CLIPPY_OPEN_RESPONSES_STORAGE_KEY = 'mykey.clippy.open_responses_enabled'
const CLIPPY_SKILLS_STORAGE_KEY = 'mykey.clippy.custom_skills'
const CLIPPY_STYLE_PROMPT_DEFAULT =
  '语气偏务实、明确，先给结论，再给可执行步骤。优先结合当前网关和流量上下文，不给空泛建议。'
const PYTHON_TIMEOUT_DEFAULT_MS = 30_000
const PYTHON_TIMEOUT_MIN_MS = 500
const PYTHON_TIMEOUT_MAX_MS = 120_000
const PYTHON_OUTPUT_MAX_CHARS_DEFAULT = 8_000
const PYTHON_OUTPUT_MAX_CHARS_MIN = 256
const PYTHON_OUTPUT_MAX_CHARS_ABS_MAX = 200_000

type ClippyChatStatus =
  | 'welcome'
  | 'idle'
  | 'thinking'
  | 'responding'
  | 'analyzing'
  | 'executing'
  | 'auto_reminding'

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

const CLIPPY_ANIMATION_HINT_KEYS: ClippyAnimationKey[] = [
  'Thinking',
  'GetAttention',
  'Wave',
  'Alert',
  'CheckingSomething',
  'IdleHeadScratch',
  'IdleFingerTap',
  'IdleEyeBrowRaise',
  'IdleSideToSide',
  'IdleAtom',
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

function normalizeAnimationToken(value: string) {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '')
}

function resolveAnimationKey(raw: string): ClippyAnimationKey | undefined {
  const token = normalizeAnimationToken(raw)
  if (!token) return undefined

  const direct = (Object.keys(CLIPPY_ANIMATIONS) as ClippyAnimationKey[]).find(
    (item) => normalizeAnimationToken(item) === token
  )
  if (direct) return direct

  const aliasMap: Record<string, ClippyAnimationKey> = {
    lookup: 'CheckingSomething',
    lookupright: 'CheckingSomething',
    lookupleft: 'CheckingSomething',
    lookright: 'GetAttention',
    lookleft: 'GetAttention',
    lookdown: 'CheckingSomething',
    lookdownleft: 'CheckingSomething',
    lookdownright: 'CheckingSomething',
    processing: 'Thinking',
    searching: 'CheckingSomething',
    writing: 'Thinking',
    explain: 'GetAttention',
    gestureup: 'Wave',
    gesturedown: 'Wave',
    gestureleft: 'GetAttention',
    gestureright: 'GetAttention',
  }
  return aliasMap[token]
}

function parseAssistantPayload(
  raw: string,
  capabilityMap: Record<string, MykeyCapability>
): { answerText: string; actions: SuggestedCommand[]; animationKey?: ClippyAnimationKey } {
  const source = raw.trim()
  const animationMatch = source.match(/^\s*\[\s*([A-Za-z0-9_\- ]+)\s*\]\s*/)
  const animationKey = animationMatch ? resolveAnimationKey(animationMatch[1]) : undefined
  const withoutAnimation =
    animationKey && animationMatch ? source.slice(animationMatch[0].length).trimStart() : source
  const parsed = parseMykeyActionBlock(withoutAnimation, capabilityMap)

  return {
    answerText: parsed.answerText,
    actions: parsed.actions,
    animationKey,
  }
}

function clampInt(raw: string) {
  const next = Number.parseInt(raw, 10)
  if (!Number.isFinite(next)) return null
  return next
}

function cleanPythonFence(code: string) {
  const trimmed = code.trim()
  const fenced = trimmed.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/)
  if (fenced) {
    return fenced[1].trim()
  }
  return trimmed
}

function parseDollarInvocation(raw: string): ParsedDollarInvocation {
  const source = raw.trim()
  if (!source.startsWith('$')) {
    return { kind: 'none', query: source }
  }

  const withoutDollar = source.slice(1).trim()
  if (!withoutDollar) {
    return {
      kind: 'none',
      query: source,
      error: '请输入 $py/$skill/$mykey 后接内容',
    }
  }

  const [rawCommand, ...restParts] = withoutDollar.split(/\s+/)
  const command = (rawCommand || '').toLowerCase()
  const rest = restParts.join(' ').trim()

  if (command === 'py' || command === 'python') {
    const tokens = rest.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) {
      return {
        kind: 'python',
        query: source,
        error: '请在 $python 后输入 Python 代码。',
      }
    }

    let idx = 0
    let timeoutMs: number | undefined
    let maxOutputChars: number | undefined
    const pythonArgs: string[] = []

    while (idx < tokens.length) {
      const token = tokens[idx]
      if (token === '--timeout' && idx + 1 < tokens.length) {
        const next = clampInt(tokens[idx + 1])
        if (next !== null) timeoutMs = next
        idx += 2
        continue
      }
      if (token === '--max-output-chars' && idx + 1 < tokens.length) {
        const next = clampInt(tokens[idx + 1])
        if (next !== null) maxOutputChars = next
        idx += 2
        continue
      }
      if (token.startsWith('--timeout=')) {
        const next = clampInt(token.slice('--timeout='.length))
        if (next !== null) timeoutMs = next
        idx += 1
        continue
      }
      if (token.startsWith('--max-output-chars=')) {
        const next = clampInt(token.slice('--max-output-chars='.length))
        if (next !== null) maxOutputChars = next
        idx += 1
        continue
      }
      if (token === '--arg' && idx + 1 < tokens.length) {
        pythonArgs.push(tokens[idx + 1])
        idx += 2
        continue
      }
      if (token.startsWith('--arg=')) {
        pythonArgs.push(token.slice('--arg='.length))
        idx += 1
        continue
      }
      break
    }

    const codeRaw = cleanPythonFence(tokens.slice(idx).join(' '))
    if (!codeRaw) {
      return {
        kind: 'python',
        query: source,
        error: '未识别到可执行 Python 代码。',
      }
    }

    return {
      kind: 'python',
      query: source,
      code: codeRaw,
      timeoutMs,
      maxOutputChars,
      pythonArgs,
    }
  }

  if (command === 'skill') {
    if (!rest) {
      return {
        kind: 'none',
        query: source,
        error: '$skill 需要指定技能名，例如 $skill code-review',
      }
    }

    const [name, ...promptParts] = rest.split(/\s+/)
    if (!name) {
      return {
        kind: 'none',
        query: source,
        error: '$skill 需要指定技能名，例如 $skill code-review',
      }
    }

    let skillModel: string | undefined
    const promptTokens: string[] = []
    let idx = 0
    while (idx < promptParts.length) {
      const token = promptParts[idx]
      if (!token) {
        idx += 1
        continue
      }
      if (token === '--model' && idx + 1 < promptParts.length) {
        const next = promptParts[idx + 1]
        if (next) {
          skillModel = next.trim()
        }
        idx += 2
        continue
      }
      if (token.startsWith('--model=')) {
        skillModel = token.slice('--model='.length).trim()
        idx += 1
        continue
      }
      promptTokens.push(token)
      idx += 1
    }

    return {
      kind: 'skill',
      query: source,
      skillName: (name || '').toLowerCase(),
      skillPrompt: promptTokens.join(' ').trim(),
      skillModel: skillModel?.trim(),
    }
  }

  if (command === 'mykey' || command === 'cmd') {
    if (!rest) {
      return {
        kind: 'none',
        query: source,
        error: '$mykey 需要命令名称，例如 $mykey gateway.status',
      }
    }

    const [mykeyCommand, ...rawArgParts] = rest.split(/\s+/)
    if (!mykeyCommand) {
      return {
        kind: 'none',
        query: source,
        error: '$mykey 需要命令名称，例如 $mykey gateway.status',
      }
    }

    const rawArgs = rawArgParts.join(' ').trim()
    const parseArgValue = (value: string) => {
      const trimmed = value.trim()
      if (trimmed === 'true') return true
      if (trimmed === 'false') return false
      if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
        const parsed = Number(trimmed)
        if (!Number.isNaN(parsed)) return parsed
      }
      if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1)
      }
      return trimmed
    }

    let mykeyArgs: Record<string, unknown> = {}
    if (rawArgs) {
      const asJson = rawArgs.startsWith('{') && rawArgs.endsWith('}')
      if (asJson) {
        try {
          const parsed = JSON.parse(rawArgs)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            mykeyArgs = parsed as Record<string, unknown>
          }
        } catch {
          return {
            kind: 'none',
            query: source,
            error: 'mykey 参数 JSON 解析失败，支持 JSON 对象或 --key=value 写法。',
          }
        }
      } else {
        const tokens = rawArgParts.filter(Boolean)
        const positional: string[] = []
        let idx = 0
        while (idx < tokens.length) {
          const token = tokens[idx]
          if (!token) {
            idx += 1
            continue
          }

          if (token.includes('=') && !token.startsWith('--')) {
            const [key, ...restValue] = token.split('=')
            const keyTrimmed = key.trim()
            if (keyTrimmed) {
              mykeyArgs[keyTrimmed] = parseArgValue(restValue.join('='))
            }
            idx += 1
            continue
          }

          if (token.startsWith('--')) {
            const clean = token.slice(2)
            if (!clean) {
              idx += 1
              continue
            }

            if (clean.includes('=')) {
              const [key, ...restValue] = clean.split('=')
              if (key) mykeyArgs[key] = parseArgValue(restValue.join('='))
              idx += 1
              continue
            }

            if (idx + 1 < tokens.length && !tokens[idx + 1].startsWith('--')) {
              mykeyArgs[clean] = parseArgValue(tokens[idx + 1])
              idx += 2
              continue
            }

            mykeyArgs[clean] = true
            idx += 1
            continue
          }

          positional.push(token)
          idx += 1
        }

        if (positional.length > 0) {
          positional.forEach((value, index) => {
            mykeyArgs[`arg${index + 1}`] = parseArgValue(value)
          })
        }
      }
    }

    return {
      kind: 'mykey',
      query: source,
      mykeyCommand: mykeyCommand.toLowerCase(),
      mykeyArgs,
    }
  }

  return {
    kind: 'none',
    query: source,
    error: `未识别的 $ 命令：${command}。可用：$py, $python, $skill, $mykey。`,
  }
}

function formatPythonResult(result: PythonRunResult) {
  const stdout = result.stdout ? result.stdout.trim() : ''
  const stderr = result.stderr ? result.stderr.trim() : ''
  const lines = [
    `Python ${result.python} 执行完成（退出码 ${result.exit_code}，耗时 ${result.duration_ms}ms）。`,
    stdout ? `STDOUT:\n${stdout}` : '',
    stderr ? `STDERR:\n${stderr}` : '',
  ].filter(Boolean)
  return lines.join('\n')
}

function chatStatusLabel(status: ClippyChatStatus) {
  if (status === 'welcome') return '欢迎'
  if (status === 'thinking') return '思考中'
  if (status === 'responding') return '回复中'
  if (status === 'analyzing') return '分析中'
  if (status === 'executing') return '执行中'
  if (status === 'auto_reminding') return '自动巡检'
  return '待命'
}

function formatCommandResult(result: unknown) {
  const raw = typeof result === 'string' ? result : JSON.stringify(result)
  if (!raw) return 'ok'
  return raw.length > 280 ? `${raw.slice(0, 280)}...` : raw
}

function formatPrettyResult(result: unknown, max = 5000) {
  if (result === undefined || result === null) return 'ok'

  let raw: string
  if (typeof result === 'string') {
    raw = result
  } else {
    try {
      raw = JSON.stringify(result, null, 2)
    } catch {
      raw = String(result)
    }
  }

  if (!raw) return 'ok'
  return raw.length > max ? `${raw.slice(0, max)}...` : raw
}

function shouldTriggerAutoReminder(
  suggestions: AssistantSuggestion[],
  policy: GatewayPolicySettings | null,
  traffic: GatewayTrafficMetrics | null
) {
  const top = suggestions[0]
  if (!top) return false
  if (top.severity === 'critical') return true

  const requests = traffic?.total_requests ?? 0
  if (top.severity === 'warning' && requests >= 8) return true

  if (policy?.daily_budget_usd && policy.daily_budget_usd > 0) {
    const ratio = policy.today_cost_usd / policy.daily_budget_usd
    if (ratio >= 0.75) return true
  }

  if (traffic && traffic.total_requests >= 12) {
    const successRate = traffic.success_requests / traffic.total_requests
    if (successRate < 0.95) return true
    if ((traffic.avg_latency_ms ?? 0) >= 4200) return true
  }

  return false
}

function buildAutoReminderSignature(
  suggestions: AssistantSuggestion[],
  policy: GatewayPolicySettings | null,
  traffic: GatewayTrafficMetrics | null
) {
  const top = suggestions[0]
  const successRate =
    traffic && traffic.total_requests > 0 ? traffic.success_requests / traffic.total_requests : 1
  const successBucket = Math.floor(successRate * 20)
  const latencyBucket = Math.floor((traffic?.avg_latency_ms ?? 0) / 500)
  const budgetBucket =
    policy?.daily_budget_usd && policy.daily_budget_usd > 0
      ? Math.floor((policy.today_cost_usd / policy.daily_budget_usd) * 10)
      : -1

  return [
    top?.id || 'none',
    top?.severity || 'info',
    `s${successBucket}`,
    `l${latencyBucket}`,
    `b${budgetBucket}`,
  ].join('|')
}

function buildAutoReminderFallback(
  suggestions: AssistantSuggestion[],
  policy: GatewayPolicySettings | null,
  traffic: GatewayTrafficMetrics | null
) {
  const top = suggestions[0]
  const snapshot = summarizeCurrentSituation(policy, traffic)
  if (!top) return `当前无明显风险。${snapshot}`
  if (top.severity === 'critical') {
    return `检测到高优先级风险：${top.title}。建议现在先处理这个问题。${snapshot}`
  }
  if (top.severity === 'warning') {
    return `发现需要关注的项：${top.title}。建议在本轮先优化该项，再复查成功率与延迟。${snapshot}`
  }
  return `当前整体稳定。建议继续观察趋势，并每次变更后复查数据。${snapshot}`
}

function compactReminderText(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return '当前需要你关注一项风险，请打开面板查看详情。'
  return normalized.length > 210 ? `${normalized.slice(0, 210)}...` : normalized
}

function mergeSuggestedCommands(current: SuggestedCommand[], incoming: SuggestedCommand[]) {
  if (incoming.length === 0) return current
  const exists = new Set(current.map((item) => `${item.command}|${JSON.stringify(item.args || {})}`))
  const appended = incoming.filter((item) => {
    const key = `${item.command}|${JSON.stringify(item.args || {})}`
    if (exists.has(key)) return false
    exists.add(key)
    return true
  })
  return appended.length > 0 ? [...current, ...appended] : current
}

const SKILL_MAX_PROMPT_LENGTH = 4000
const SKILL_STORAGE_MAX_COUNT = 40

function truncateText(raw: string, max = 2200) {
  const value = raw.trim()
  return value.length > max ? `${value.slice(0, max)}...` : value
}

function normalizeSkillName(raw: string) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
}

function normalizeCustomSkills(raw: unknown) {
  if (!Array.isArray(raw)) return []
  const list: ClippySkill[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const source = item as Record<string, unknown>
    const name = typeof source.name === 'string' ? source.name.trim() : ''
    if (!name) continue
    list.push({
      name,
      description: typeof source.description === 'string' ? source.description.trim() : '',
      tags: Array.isArray(source.tags)
        ? source.tags
            .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
            .filter(Boolean)
        : [],
      prompt: typeof source.prompt === 'string' ? source.prompt.trim().slice(0, SKILL_MAX_PROMPT_LENGTH) : '',
      boundModel:
        typeof source.boundModel === 'string'
          ? source.boundModel.trim()
          : typeof source.model === 'string'
            ? source.model.trim()
            : '',
      source: 'custom',
    })
  }
  return list.slice(0, SKILL_STORAGE_MAX_COUNT)
}

function mergeSkillSources(builtin: ClippySkill[], custom: ClippySkill[]) {
  const next: ClippySkill[] = []
  const map = new Map<string, ClippySkill>()
  for (const item of builtin) {
    const normalized = normalizeSkillName(item.name)
    if (!normalized) continue
    map.set(normalized, { ...item, source: 'builtin' })
  }
  for (const item of custom) {
    const normalized = normalizeSkillName(item.name)
    if (!normalized) continue
    map.set(normalized, {
      ...map.get(normalized),
      ...item,
      source: 'custom',
      name: item.name,
    })
  }
  for (const item of map.values()) {
    next.push(item)
  }
  next.sort((a, b) => a.name.localeCompare(b.name))
  return next
}

function formatPythonStructuredOutput(value: unknown) {
  if (value === undefined || value === null) return ''
  try {
    const raw = JSON.stringify(value, null, 2)
    return `Python 结构化输出（JSON）:\n${truncateText(raw, 2800)}`
  } catch {
    return `Python 结构化输出：${truncateText(String(value), 2400)}`
  }
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
  const [chatStatus, setChatStatus] = useState<ClippyChatStatus>('welcome')
  const [askInput, setAskInput] = useState('')
  const [unread, setUnread] = useState(0)
  const [lastAnalyzedAt, setLastAnalyzedAt] = useState<Date | null>(null)
  const [agentMode, setAgentMode] = useState<AgentMode>('fallback')
  const [gatewayCreds, setGatewayCreds] = useState<GatewayAccessCredentials | null>(null)
  const [capabilities, setCapabilities] = useState<MykeyCapability[]>([])
  const [skills, setSkills] = useState<ClippySkill[]>([])
  const [suggestedCommands, setSuggestedCommands] = useState<SuggestedCommand[]>([])
  const [batchExecuting, setBatchExecuting] = useState(false)
  const [autoRemindEnabled, setAutoRemindEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    try {
      const raw = window.localStorage.getItem(AUTO_REMINDER_STORAGE_KEY)
      return raw === null ? true : raw === '1'
    } catch {
      return true
    }
  })
  const [animationProtocolEnabled, setAnimationProtocolEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    try {
      const raw = window.localStorage.getItem(CLIPPY_ANIMATION_PROTOCOL_STORAGE_KEY)
      return raw === null ? true : raw === '1'
    } catch {
      return true
    }
  })
  const [assistantStylePrompt, setAssistantStylePrompt] = useState<string>(() => {
    if (typeof window === 'undefined') return CLIPPY_STYLE_PROMPT_DEFAULT
    try {
      const raw = window.localStorage.getItem(CLIPPY_STYLE_PROMPT_STORAGE_KEY)
      return raw && raw.trim() ? raw.trim() : CLIPPY_STYLE_PROMPT_DEFAULT
    } catch {
      return CLIPPY_STYLE_PROMPT_DEFAULT
    }
  })
  const [openResponsesEnabled, setOpenResponsesEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try {
      const raw = window.localStorage.getItem(CLIPPY_OPEN_RESPONSES_STORAGE_KEY)
      return raw === null ? false : raw === '1'
    } catch {
      return false
    }
  })
  const [assistantStyleDraft, setAssistantStyleDraft] = useState(assistantStylePrompt)
  const [styleEditorOpen, setStyleEditorOpen] = useState(false)
  const [skillEditorOpen, setSkillEditorOpen] = useState(false)
  const [skillDraftName, setSkillDraftName] = useState('')
  const [skillDraftDescription, setSkillDraftDescription] = useState('')
  const [skillDraftPrompt, setSkillDraftPrompt] = useState('')
  const [skillDraftModel, setSkillDraftModel] = useState('')
  const [editingCustomSkill, setEditingCustomSkill] = useState('')
  const [skillCatalog, setSkillCatalog] = useState<GatewayModelCatalogItem[]>([])
  const [animationCue, setAnimationCue] = useState(0)
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
  const queuedAnimationRef = useRef<ClippyAnimationKey>()
  const styleCommitTimerRef = useRef<number>()
  const lastAutoReminderAtRef = useRef(0)
  const lastAutoReminderSignatureRef = useRef('')
  const autoReminderRunningRef = useRef(false)
  const runtimeGatewayOnline = agentMode === 'codex'
  const capabilityMap = useMemo(() => {
    const map: Record<string, MykeyCapability> = {}
    for (const item of capabilities) {
      map[item.id] = item
    }
    return map
  }, [capabilities])
  const skillMap = useMemo(() => {
    const map: Record<string, ClippySkill> = {}
    for (const skill of skills) {
      map[skill.name.toLowerCase()] = skill
    }
    return map
  }, [skills])
  const builtinSkillCount = useMemo(
    () => skills.filter((item) => item.source !== 'custom').length,
    [skills]
  )
  const builtinSkillsOnly = useMemo(
    () => skills.filter((item) => item.source !== 'custom'),
    [skills]
  )
  const customSkillsOnly = useMemo(
    () => skills.filter((item) => item.source === 'custom'),
    [skills]
  )
  const skillModelOptions = useMemo(() => {
    const names = new Set<string>()
    for (const item of skillCatalog) {
      if (item.model && item.model.trim()) {
        names.add(item.model.trim())
      }
    }
    return Array.from(names).sort()
  }, [skillCatalog])

  const suggestions = useMemo(
    () => buildSuggestions(settings, policy, traffic, usageStatuses, runtimeGatewayOnline),
    [policy, runtimeGatewayOnline, settings, traffic, usageStatuses]
  )

  const topSeverity = suggestions[0]?.severity || 'info'
  const safeActionCount = useMemo(() => {
    return suggestedCommands.filter(
      (item) =>
        !item.mutating && (item.status === 'pending' || item.status === 'failed')
    ).length
  }, [suggestedCommands])
  const mutatingActionCount = useMemo(() => {
    return suggestedCommands.filter(
      (item) =>
        item.mutating && (item.status === 'pending' || item.status === 'failed')
    ).length
  }, [suggestedCommands])

  const addAssistantMessage = (text: string) => {
    setMessages((prev) => [...prev, { id: `${Date.now()}-${prev.length}`, role: 'assistant', text }])
  }

  const triggerClippyAnimation = (key: ClippyAnimationKey) => {
    queuedAnimationRef.current = key
    setAnimationCue((prev) => prev + 1)
  }

  const commitAssistantStyleDraft = () => {
    const next = assistantStyleDraft.trim() || CLIPPY_STYLE_PROMPT_DEFAULT
    setAssistantStylePrompt(next)
    setAssistantStyleDraft(next)
  }

  const readLocalSkills = () => {
    if (typeof window === 'undefined') return [] as ClippySkill[]
    try {
      const raw = window.localStorage.getItem(CLIPPY_SKILLS_STORAGE_KEY)
      if (!raw) return []
      return normalizeCustomSkills(JSON.parse(raw))
    } catch {
      return []
    }
  }

  const syncSkillStorage = (list: ClippySkill[]) => {
    if (typeof window === 'undefined') return
    try {
      const payload: StoredClippySkill[] = list
        .filter((item) => item.source === 'custom')
        .map((item) => ({
          name: item.name.trim(),
          description: (item.description || '').trim(),
          tags: item.tags || [],
          prompt: (item.prompt || '').trim(),
          boundModel: (item.boundModel || '').trim(),
        }))
      window.localStorage.setItem(CLIPPY_SKILLS_STORAGE_KEY, JSON.stringify(payload))
    } catch {
      // ignore
    }
  }

  const resetSkillDraft = () => {
    setEditingCustomSkill('')
    setSkillDraftName('')
    setSkillDraftDescription('')
    setSkillDraftPrompt('')
    setSkillDraftModel('')
  }

  const applySkillDraftToForm = (skill: ClippySkill) => {
    setEditingCustomSkill(skill.name)
    setSkillDraftName(skill.name)
    setSkillDraftDescription(skill.description || '')
    setSkillDraftPrompt(skill.prompt || '')
    setSkillDraftModel(skill.boundModel || '')
    setSkillEditorOpen(true)
  }

  const saveCustomSkillDraft = () => {
    const name = skillDraftName.trim()
    if (!name) return
    const nextPrompt = skillDraftPrompt.trim()
    const nextDescription = skillDraftDescription.trim()
    const nextModel = skillDraftModel.trim()
    const normalizedName = normalizeSkillName(name)
    const isUpdating = customSkillsOnly.some((item) => normalizeSkillName(item.name) === normalizedName)
    const isEditingExisting = Boolean(
      editingCustomSkill && normalizeSkillName(editingCustomSkill) === normalizedName
    )
    const wouldAddNew = !isUpdating && !isEditingExisting
    if (wouldAddNew && customSkillsOnly.length >= SKILL_STORAGE_MAX_COUNT) {
      addAssistantMessage('自定义技能数量已达上限，请先删除不再使用的技能后再新增。')
      return
    }

    const nextRecord: ClippySkill = {
      name,
      description: nextDescription || '自定义技能',
      tags: ['custom'],
      prompt: nextPrompt || '请按该技能给出可执行建议。',
      boundModel: nextModel,
      source: 'custom',
    }

    setSkills((previous) => {
      const rest = previous.filter((item) => {
        const normalized = normalizeSkillName(item.name)
        return normalized !== normalizeSkillName(name)
      })
      const merged = [...rest, nextRecord]
      syncSkillStorage(merged)
      return merged.sort((a, b) => a.name.localeCompare(b.name))
    })
    setSkillEditorOpen(false)
    resetSkillDraft()
  }

  const beginCreateCustomSkill = () => {
    if (customSkillsOnly.length >= SKILL_STORAGE_MAX_COUNT) {
      addAssistantMessage('自定义技能数量已达上限，请先删除不再使用的技能后再创建。')
      return
    }
    resetSkillDraft()
    setSkillEditorOpen(true)
  }

  const deleteCustomSkillDraft = (targetName: string) => {
    setSkills((previous) => {
      const next = previous.filter((item) => normalizeSkillName(item.name) !== normalizeSkillName(targetName))
      syncSkillStorage(next)
      return next
    })
    if (editingCustomSkill && normalizeSkillName(editingCustomSkill) === normalizeSkillName(targetName)) {
      resetSkillDraft()
    }
  }

  const runAnalysis = async (silent = false) => {
    if (!masterPassword) return
    if (!silent) {
      setChatStatus('analyzing')
      triggerClippyAnimation('CheckingSomething')
    }
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
    } finally {
      if (!silent) {
        setChatStatus('idle')
      }
    }
  }

  const askByCodex = async (
    question: string,
    options?: { skill?: ClippySkill; stream?: boolean; openResponses?: boolean; model?: string }
  ) => {
    if (!gatewayCreds) throw new Error('Codex 网关凭证不可用')
    const useOpenResponses = options?.openResponses ?? openResponsesEnabled

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
    const skillHint = options?.skill
      ? [
          `已通过 Skills 调用：${options.skill.name}`,
          options.skill.description ? `技能描述：${options.skill.description}` : '技能描述：无',
          options.skill.prompt ? `技能提示词：${options.skill.prompt}` : '技能提示词：无',
          options.skill.boundModel ? `模型绑定：${options.skill.boundModel}` : '模型绑定：未设置（使用默认）',
          options.skill.tags.length > 0 ? `标签：${options.skill.tags.join(', ')}` : '标签：无',
        ].join('\n')
      : ''

    const systemPrompt = [
      '你是 MyKey 内置的 Clippy 助手。输出请简短、直接、可执行。',
      '你的主要目标是帮助用户降低 API 成本、提高稳定性、改善路由配置。',
      `用户偏好风格: ${assistantStylePrompt}`,
      `当前网关状态: ${runtimeGatewayOnline ? '在线' : '离线'}`,
      '模型策略（强约束）：当前主链路是 Codex，本轮优先模型必须是 gpt-5-codex。',
      '如果用户问“现在用哪个模型最合适”，默认先给出 gpt-5-codex，再说明何时降级。',
      '除非用户明确要求极限省成本或低延迟，否则不要主动推荐 gpt-4o-mini / gpt-3.5。',
      '当网关在线时，不要建议“先检查端口并重启网关”。',
      `Open Responses 协议：${useOpenResponses ? '已开启' : '未开启'}。`,
      `当前系统概览: ${summarizeCurrentSituation(policy, traffic)}`,
      '当前风险与建议:',
      riskTop || '暂无高优先级风险。',
      '如果用户提问不明确，优先给出接下来 1-3 步具体操作。',
      '你可以建议执行 mykey 命令。若建议执行，请在回复末尾附加一个代码块：',
      '```mykey-actions',
      '{"actions":[{"command":"gateway.status","args":{},"reason":"说明原因"}]}',
      '```',
      '只允许使用提供的能力命令，最多 3 条；若不需要执行则不要输出该代码块。',
      skillHint ? `技能上下文：${skillHint}` : '',
      animationProtocolEnabled
        ? `你可以在回复开头使用一个动画标签，格式示例：[Thinking] 或 [GetAttention]。可用标签：${CLIPPY_ANIMATION_HINT_KEYS.join(', ')}。动画标签只允许出现一次且必须位于最开头。`
        : '不要输出任何动画标签。',
      '可用命令:',
      capabilityHints || '- (无)',
      '默认使用中文回答。',
    ].join('\n')

    const richQuestion = `最近会话:\n${recentMsgs || '无'}\n\n用户问题: ${question}`
    return invoke<string>('clippy_codex_chat', {
      question: richQuestion,
      systemPrompt,
      model: options?.model?.trim() || 'gpt-5-codex',
      openResponses: useOpenResponses,
      stream: options?.stream ?? false,
      masterPassword,
    })
  }

  const addCodexMessageFromRaw = (question: string, rawAnswer: string) => {
    const { answerText, actions, animationKey } = parseAssistantPayload(rawAnswer, capabilityMap)
    const displayText =
      answerText || (actions.length > 0 ? '已生成可执行操作建议，请按需一键执行。' : rawAnswer)
    const answer = normalizeCodexAnswerForModelQuestion(question, displayText, runtimeGatewayOnline)
    if (animationProtocolEnabled && animationKey) {
      triggerClippyAnimation(animationKey)
    } else {
      triggerClippyAnimation('GetAttention')
    }
    setChatStatus('responding')
    addAssistantMessage(answer)
    if (actions.length > 0) {
      setSuggestedCommands((prev) => mergeSuggestedCommands(prev, actions))
      const safeCount = actions.filter((item) => !item.mutating).length
      const riskyCount = actions.filter((item) => item.mutating).length
      addAssistantMessage(
        `已生成 ${actions.length} 条可执行操作建议（只读 ${safeCount} / 变更 ${riskyCount}），可在下方按计划执行。`
      )
    }
    setAgentError('')
  }

  const updateOpenResponsesSetting = async (next: boolean) => {
    const prev = openResponsesEnabled
    if (prev === next) return

    setOpenResponsesEnabled(next)
    try {
      await invoke<unknown>('mykey_command', {
        command: 'gateway.open_responses.set',
        args: { enabled: next },
        masterPassword,
      })
      addAssistantMessage(`已${next ? '启用' : '禁用'} Open Responses 协议。`)
    } catch (error) {
      setOpenResponsesEnabled(prev)
      const message = normalizeError(error)
      addAssistantMessage(`Open Responses 设置失败：${message}`)
    }
  }

  const runPythonInvocation = async (invocation: ParsedDollarInvocation) => {
    if (invocation.kind !== 'python' || !invocation.code) return
    const code = invocation.code.trim()
    if (!code) {
      throw new Error('Python 代码为空')
    }

    const timeout = Math.max(
      PYTHON_TIMEOUT_MIN_MS,
      Math.min(PYTHON_TIMEOUT_MAX_MS, invocation.timeoutMs ?? PYTHON_TIMEOUT_DEFAULT_MS)
    )
    const maxOutputChars = Math.max(
      PYTHON_OUTPUT_MAX_CHARS_MIN,
      Math.min(
        PYTHON_OUTPUT_MAX_CHARS_ABS_MAX,
        invocation.maxOutputChars ?? PYTHON_OUTPUT_MAX_CHARS_DEFAULT
      )
    )

    setChatStatus('executing')
    triggerClippyAnimation('CheckingSomething')
    const result = await invoke<PythonRunResult>('run_python_code', {
      code,
      timeout_ms: timeout,
      max_output_chars: maxOutputChars,
      python_args: invocation.pythonArgs || [],
      masterPassword,
    })
    setChatStatus('responding')
    addAssistantMessage(formatPythonResult(result))
    if (result.structured_output !== undefined) {
      const structured = formatPythonStructuredOutput(result.structured_output)
      if (structured) {
        addAssistantMessage(structured)
      }
    }
  }

  const runSkillInvocation = async (invocation: ParsedDollarInvocation) => {
    if (invocation.kind !== 'skill' || !invocation.skillName) {
      throw new Error('技能指令格式不完整')
    }

    const skill = skillMap[invocation.skillName]
    if (!skill) {
      const known = Object.keys(skillMap)
        .slice(0, 8)
        .sort()
        .join(' / ')
      const suffix = known ? `可用技能：${known}` : '当前尚无可用技能'
      throw new Error(`未找到技能：${invocation.skillName}。${suffix}`)
    }

    const skillPrompt = [
      skill.prompt ? `技能提示词：${skill.prompt}` : '请按该技能给出可执行建议。',
      invocation.skillPrompt ? `用户指令：${invocation.skillPrompt}` : '用户未提供额外指令，按默认行为执行。',
    ].join('\n')
    const nextModel = invocation.skillModel || skill.boundModel
    const rawAnswer = await askByCodex(skillPrompt, { skill, model: nextModel })
    addCodexMessageFromRaw(skillPrompt, rawAnswer)
  }

  const runMykeyInvocation = async (invocation: ParsedDollarInvocation) => {
    if (invocation.kind !== 'mykey' || !invocation.mykeyCommand) {
      throw new Error('mykey 指令格式不完整')
    }

    const command = invocation.mykeyCommand
    if (!capabilityMap[command]) {
      const list = Object.keys(capabilityMap)
        .slice(0, 12)
        .sort()
        .join(' / ')
      const hint = list ? `可用能力：${list}` : '当前尚无可用能力'
      throw new Error(`未识别能力：${command}。${hint}`)
    }

    setChatStatus('executing')
    triggerClippyAnimation('CheckingSomething')
    const args =
      invocation.mykeyArgs && Object.keys(invocation.mykeyArgs).length > 0 ? invocation.mykeyArgs : undefined
    const payload: { command: string; args?: Record<string, unknown>; masterPassword: string } = {
      command,
      masterPassword,
    }
    if (args) {
      payload.args = args
    }
    const result = await invoke<unknown>('mykey_command', payload)
    setChatStatus('responding')
    triggerClippyAnimation('GetAttention')
    addAssistantMessage(`${command} 执行完成：${formatPrettyResult(result)}`)
  }

  const askByText = async (question: string) => {
    const q = question.trim()
    if (!q || busy) return

    setMessages((prev) => [...prev, { id: `${Date.now()}-u`, role: 'user', text: q }])
    setAskInput('')
    setBusy(true)
    setChatStatus('thinking')
    triggerClippyAnimation('Thinking')

    try {
      const invocation = parseDollarInvocation(q)
      if (invocation.error) {
        addAssistantMessage(`命令解析失败：${invocation.error}`)
        return
      }

      if (invocation.kind === 'python') {
        await runPythonInvocation(invocation)
        return
      }

      if (invocation.kind === 'skill') {
        if (agentMode === 'codex' && gatewayCreds) {
          await runSkillInvocation(invocation)
        } else {
          addAssistantMessage('技能调用目前仅支持 Codex 通道，当前未连接在线模型。')
        }
        return
      }

      if (invocation.kind === 'mykey') {
        await runMykeyInvocation(invocation)
        return
      }

      if (agentMode === 'codex' && gatewayCreds) {
        const rawAnswer = await askByCodex(q)
        addCodexMessageFromRaw(q, rawAnswer)
      } else {
        setChatStatus('responding')
        triggerClippyAnimation('CheckingSomething')
        addAssistantMessage(buildFallbackAnswer(q, policy, traffic, suggestions))
      }
    } catch (error) {
      const message = normalizeError(error)
      setAgentError(message)
      const fallback = buildFallbackAnswer(q, policy, traffic, suggestions)
      addAssistantMessage(`Codex 代理暂时不可用，已切换规则建议：${fallback}`)
    } finally {
      setBusy(false)
      setChatStatus('idle')
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setGreetingActive(false)
      setChatStatus('idle')
    }, CLIPPY_IDLE_GREET_MS)
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

    const queuedAnimation = queuedAnimationRef.current
    if (queuedAnimation) {
      queuedAnimationRef.current = undefined
      playOneShot(queuedAnimation)
      return clearAnimationTimers
    }

    if (
      busy ||
      chatStatus === 'thinking' ||
      chatStatus === 'analyzing' ||
      chatStatus === 'auto_reminding'
    ) {
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
      setAvatarSrc(
        chatStatus === 'responding'
          ? CLIPPY_ANIMATIONS.GetAttention.src
          : CLIPPY_ANIMATIONS.Default.src
      )
      return clearAnimationTimers
    }

    setAvatarSrc(CLIPPY_ANIMATIONS.Default.src)
    idleTimeoutRef.current = window.setTimeout(playIdleLoop, CLIPPY_IDLE_WAIT_MS)
    return clearAnimationTimers
  }, [animationCue, busy, chatStatus, greetingActive, open, topSeverity])

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
        const localSkills = readLocalSkills()
        const skillList = await invoke<ClippySkill[]>('get_claude_tool_manager_skills', {
          masterPassword,
        })
        if (!canceled) {
          setSkills(mergeSkillSources(
            skillList.map((item) => ({ ...item, source: 'builtin' as const })),
            localSkills
          ))
        }
      } catch {
        if (!canceled) {
          setSkills(mergeSkillSources([], readLocalSkills()))
        }
      }

      try {
        const catalog = await invoke<GatewayModelCatalogItem[]>('list_gateway_model_catalog', {
          masterPassword,
        })
        if (!canceled) {
          setSkillCatalog(catalog)
        }
      } catch {
        if (!canceled) {
          setSkillCatalog([])
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

      try {
        const openSetting = await invoke<{ open_responses: boolean }>('mykey_command', {
          command: 'gateway.open_responses.get',
          masterPassword,
        })
        if (!canceled && typeof openSetting.open_responses === 'boolean') {
          setOpenResponsesEnabled(openSetting.open_responses)
        }
      } catch {
        // keep localStorage preference as fallback
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
  }, [masterPassword, runtimeGatewayOnline])

  useEffect(() => {
    openRef.current = open
  }, [open])

  useEffect(() => {
    if (open) setUnread(0)
  }, [open])

  useEffect(() => {
    try {
      window.localStorage.setItem(AUTO_REMINDER_STORAGE_KEY, autoRemindEnabled ? '1' : '0')
    } catch {
      // ignore local storage failure
    }
  }, [autoRemindEnabled])

  useEffect(() => {
    try {
      window.localStorage.setItem(
        CLIPPY_ANIMATION_PROTOCOL_STORAGE_KEY,
        animationProtocolEnabled ? '1' : '0'
      )
    } catch {
      // ignore local storage failure
    }
  }, [animationProtocolEnabled])

  useEffect(() => {
    try {
      window.localStorage.setItem(CLIPPY_STYLE_PROMPT_STORAGE_KEY, assistantStylePrompt)
    } catch {
      // ignore local storage failure
    }
  }, [assistantStylePrompt])

  useEffect(() => {
    try {
      window.localStorage.setItem(
        CLIPPY_OPEN_RESPONSES_STORAGE_KEY,
        openResponsesEnabled ? '1' : '0'
      )
    } catch {
      // ignore local storage failure
    }
  }, [openResponsesEnabled])

  useEffect(() => {
    syncSkillStorage(skills)
  }, [skills])

  useEffect(() => {
    if (assistantStyleDraft.trim() === assistantStylePrompt.trim()) return
    if (styleCommitTimerRef.current) {
      window.clearTimeout(styleCommitTimerRef.current)
    }
    styleCommitTimerRef.current = window.setTimeout(() => {
      commitAssistantStyleDraft()
      styleCommitTimerRef.current = undefined
    }, 900)
    return () => {
      if (styleCommitTimerRef.current) {
        window.clearTimeout(styleCommitTimerRef.current)
        styleCommitTimerRef.current = undefined
      }
    }
  }, [assistantStyleDraft, assistantStylePrompt])

  useEffect(() => {
    if (!open && styleEditorOpen) {
      commitAssistantStyleDraft()
      setStyleEditorOpen(false)
    }
  }, [open, styleEditorOpen])

  useEffect(() => {
    if (!masterPassword) return
    if (!autoRemindEnabled) return

    const tick = async () => {
      if (autoReminderRunningRef.current) return
      if (busy || batchExecuting) return
      if (!shouldTriggerAutoReminder(suggestions, policy, traffic)) return

      const now = Date.now()
      if (now - lastAutoReminderAtRef.current < AUTO_REMINDER_INTERVAL_MS) return

      const signature = buildAutoReminderSignature(suggestions, policy, traffic)
      if (
        signature === lastAutoReminderSignatureRef.current &&
        now - lastAutoReminderAtRef.current < AUTO_REMINDER_INTERVAL_MS * 2
      ) {
        return
      }

      autoReminderRunningRef.current = true
      setChatStatus('auto_reminding')
      try {
        let reminderText = buildAutoReminderFallback(suggestions, policy, traffic)
        let actions: SuggestedCommand[] = []

        if (agentMode === 'codex' && gatewayCreds) {
          try {
            const raw = await askByCodex(
              '这是系统定时巡检时刻。请给出一句自动提醒（80字内，直接结论+下一步），必要时可附带 mykey-actions。'
            )
            const parsed = parseAssistantPayload(raw, capabilityMap)
            reminderText = parsed.answerText || reminderText
            actions = parsed.actions
            if (animationProtocolEnabled && parsed.animationKey) {
              triggerClippyAnimation(parsed.animationKey)
            }
          } catch {
            // keep fallback reminder
          }
        }

        if (!actions.length) {
          triggerClippyAnimation(suggestions[0]?.severity === 'critical' ? 'Alert' : 'CheckingSomething')
        }
        addAssistantMessage(`自动提醒：${compactReminderText(reminderText)}`)
        if (actions.length > 0) {
          setSuggestedCommands((prev) => mergeSuggestedCommands(prev, actions))
          addAssistantMessage(`已附带 ${actions.length} 条可执行建议，可按需一键执行。`)
        }
        if (!openRef.current) {
          setUnread((prev) => prev + 1)
        }
        lastAutoReminderAtRef.current = now
        lastAutoReminderSignatureRef.current = signature
      } finally {
        autoReminderRunningRef.current = false
        setChatStatus('idle')
      }
    }

    void tick()
    const timer = window.setInterval(tick, AUTO_REMINDER_CHECK_MS)
    return () => window.clearInterval(timer)
  }, [
    agentMode,
    animationProtocolEnabled,
    assistantStylePrompt,
    autoRemindEnabled,
    openResponsesEnabled,
    batchExecuting,
    busy,
    capabilityMap,
    gatewayCreds,
    masterPassword,
    policy,
    suggestions,
    traffic,
  ])

  const runSuggestedCommand = async (
    target: SuggestedCommand,
    options?: { suppressChatMessage?: boolean }
  ): Promise<CommandRunResult> => {
    setSuggestedCommands((prev) =>
      prev.map((item) => (item.id === target.id ? { ...item, status: 'running' } : item))
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
          item.id === target.id ? { ...item, status: 'success', resultText } : item
        )
      )
      if (!options?.suppressChatMessage) {
        addAssistantMessage(`已执行 ${target.command}：${resultText}`)
      }
      return { command: target.command, ok: true, resultText }
    } catch (error) {
      const message = normalizeError(error)
      setSuggestedCommands((prev) =>
        prev.map((item) =>
          item.id === target.id ? { ...item, status: 'failed', resultText: message } : item
        )
      )
      if (!options?.suppressChatMessage) {
        addAssistantMessage(`执行 ${target.command} 失败：${message}`)
      }
      return { command: target.command, ok: false, resultText: message }
    }
  }

  const executeSuggestedCommand = async (id: string) => {
    const target = suggestedCommands.find((item) => item.id === id)
    if (!target || target.status === 'running' || batchExecuting) return
    if (target.mutating) {
      const confirmed = window.confirm(`该操作会修改配置：${target.command}\n是否继续执行？`)
      if (!confirmed) return
    }

    setChatStatus('executing')
    triggerClippyAnimation(target.mutating ? 'Alert' : 'GetAttention')
    try {
      const result = await runSuggestedCommand(target)
      if (result.ok) {
        await runAnalysis(true)
      }
    } finally {
      setChatStatus('idle')
    }
  }

  const executeAllSafeCommands = async () => {
    if (batchExecuting) return
    const targets = suggestedCommands.filter(
      (item) => !item.mutating && (item.status === 'pending' || item.status === 'failed')
    )
    if (targets.length === 0) {
      addAssistantMessage('当前没有可批量执行的只读动作。')
      return
    }

    setBatchExecuting(true)
    setBusy(true)
    setChatStatus('executing')
    triggerClippyAnimation('CheckingSomething')
    try {
      const results: CommandRunResult[] = []
      for (const target of targets) {
        const result = await runSuggestedCommand(target, { suppressChatMessage: true })
        results.push(result)
      }
      await runAnalysis(true)
      const success = results.filter((item) => item.ok)
      const failed = results.filter((item) => !item.ok)
      let summary = `批量执行完成：成功 ${success.length}，失败 ${failed.length}。`
      if (failed.length > 0) {
        summary += ` 失败命令：${failed.map((item) => item.command).join(', ')}`
      }
      addAssistantMessage(summary)
    } finally {
      setBatchExecuting(false)
      setBusy(false)
      setChatStatus('idle')
    }
  }

  const clearSuggestedCommands = () => {
    setSuggestedCommands([])
  }

  const executeAction = async (action: AssistantAction) => {
    try {
      setBusy(true)
      setChatStatus('executing')
      triggerClippyAnimation('GetAttention')
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
      setChatStatus('idle')
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
                <p className="clippy-agent-phase">状态：{chatStatusLabel(chatStatus)}</p>
              </div>
            </div>
            <button className="clippy-close-btn" onClick={() => setOpen(false)}>
              关闭
            </button>
          </header>

          <div className="clippy-summary">
            <span className={`clippy-pill ${topSeverity}`}>{topSeverity.toUpperCase()}</span>
            <p>{summarizeCurrentSituation(policy, traffic)}</p>
            <div className="clippy-auto-row">
              <span className="clippy-auto-hint">
                自动提醒：{autoRemindEnabled ? '已开启' : '已关闭'}（约每 {AUTO_REMINDER_INTERVAL_MINUTES} 分钟）
              </span>
              <div className="clippy-auto-actions">
                <button
                  className="btn btn-secondary clippy-auto-toggle"
                  onClick={() => {
                    lastAutoReminderAtRef.current = 0
                    lastAutoReminderSignatureRef.current = ''
                    void runAnalysis(true)
                  }}
                  disabled={busy}
                >
                  立即巡检
                </button>
                <button
                  className="btn btn-secondary clippy-auto-toggle"
                  onClick={() =>
                    setAutoRemindEnabled((prev) => {
                      const next = !prev
                      if (next) {
                        lastAutoReminderAtRef.current = 0
                        lastAutoReminderSignatureRef.current = ''
                      }
                      return next
                    })
                  }
                  disabled={busy}
                >
                  {autoRemindEnabled ? '关闭提醒' : '开启提醒'}
                </button>
              </div>
            </div>
            <div className="clippy-style-config">
              <button
                className="btn btn-secondary clippy-auto-toggle"
                onClick={() => setStyleEditorOpen((prev) => !prev)}
                disabled={busy}
              >
                {styleEditorOpen ? '收起互动设置' : '互动设置'}
              </button>
              {styleEditorOpen && (
                <div className="clippy-style-editor">
                  <label htmlFor="clippy-style-prompt">助手风格提示（延迟保存）</label>
                  <textarea
                    id="clippy-style-prompt"
                    rows={3}
                    value={assistantStyleDraft}
                    onChange={(event) => setAssistantStyleDraft(event.target.value)}
                    onBlur={commitAssistantStyleDraft}
                    placeholder={CLIPPY_STYLE_PROMPT_DEFAULT}
                  />
                  <label className="clippy-style-check">
                    <input
                      type="checkbox"
                      checked={animationProtocolEnabled}
                      onChange={(event) => setAnimationProtocolEnabled(event.target.checked)}
                    />
                    <span>启用动画标签协议（支持回答开头使用 [Thinking] 等标签）</span>
                  </label>
                  <label className="clippy-style-check">
                    <input
                      type="checkbox"
                      checked={openResponsesEnabled}
                      onChange={(event) => void updateOpenResponsesSetting(event.target.checked)}
                      disabled={busy}
                    />
                    <span>启用 Open Responses 协议（支持更丰富推理与工具上下文）</span>
                  </label>
                  <p className="clippy-style-note">
                    可用动画标签：{CLIPPY_ANIMATION_HINT_KEYS.join(', ')}
                  </p>
                </div>
              )}
            </div>
            <div className="clippy-skill-manager">
              <div className="clippy-skill-manager-header">
                <div>
                  <h4 className="clippy-mini-title">Skills</h4>
                  <p>
                    内置 {builtinSkillCount} 条，已存储自定义 {customSkillsOnly.length}/{SKILL_STORAGE_MAX_COUNT} 条
                  </p>
                </div>
                <div className="clippy-skill-manager-actions">
                  <button
                    className="btn btn-secondary clippy-auto-toggle"
                    onClick={() => setSkillEditorOpen((prev) => !prev)}
                    disabled={busy}
                  >
                    {skillEditorOpen ? '收起技能面板' : '技能面板'}
                  </button>
                  <button className="btn btn-primary clippy-auto-toggle" onClick={beginCreateCustomSkill} disabled={busy}>
                    新增技能
                  </button>
                </div>
              </div>

              {skillEditorOpen && (
                <div className="clippy-skill-editor">
                  <label htmlFor="clippy-skill-name">技能名称</label>
                  <input
                    id="clippy-skill-name"
                    value={skillDraftName}
                    onChange={(event) => setSkillDraftName(event.target.value)}
                    placeholder="例如：code-review"
                  />
                  <label htmlFor="clippy-skill-description">技能描述</label>
                  <textarea
                    id="clippy-skill-description"
                    rows={2}
                    value={skillDraftDescription}
                    onChange={(event) => setSkillDraftDescription(event.target.value)}
                    placeholder="简要说明该技能用途与适用场景。"
                  />
                  <label htmlFor="clippy-skill-prompt">技能提示词</label>
                  <textarea
                    id="clippy-skill-prompt"
                    rows={4}
                    value={skillDraftPrompt}
                    onChange={(event) => setSkillDraftPrompt(event.target.value)}
                    placeholder="用于约束模型输出风格与步骤。可为空，系统将使用默认提示词。"
                  />
                  <label htmlFor="clippy-skill-model">绑定模型（可选）</label>
                  <input
                    id="clippy-skill-model"
                    list="clippy-skill-model-options"
                    value={skillDraftModel}
                    onChange={(event) => setSkillDraftModel(event.target.value)}
                    placeholder="留空则使用默认模型"
                  />
                  <datalist id="clippy-skill-model-options">
                    {skillModelOptions.map((item) => (
                      <option key={item} value={item} />
                    ))}
                  </datalist>
                  <div className="clippy-skill-editor-actions">
                    <button
                      className="btn btn-primary"
                      onClick={saveCustomSkillDraft}
                      disabled={busy || !skillDraftName.trim()}
                    >
                      保存技能
                    </button>
                    <button
                      className="btn btn-secondary"
                      onClick={() => {
                        resetSkillDraft()
                        setSkillEditorOpen(false)
                      }}
                    >
                      取消
                    </button>
                    {editingCustomSkill ? (
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={() => deleteCustomSkillDraft(editingCustomSkill)}
                      >
                        删除当前编辑技能
                      </button>
                    ) : null}
                  </div>
                  {editingCustomSkill ? (
                    <p className="clippy-skill-note">
                      正在编辑：{editingCustomSkill}
                    </p>
                  ) : null}
                </div>
              )}

              <div className="clippy-skill-list">
                <div className="clippy-mini-list-title">自定义技能</div>
                {customSkillsOnly.length === 0 ? (
                  <p className="clippy-empty-state">暂无自定义技能。</p>
                ) : (
                  <div className="clippy-skill-grid">
                    {customSkillsOnly.map((skill) => (
                      <article key={skill.name} className="clippy-skill-item">
                        <div className="clippy-skill-item-header">
                          <strong>{skill.name}</strong>
                          <div className="clippy-skill-item-actions">
                            <button
                              className="btn btn-secondary"
                              onClick={() => applySkillDraftToForm(skill)}
                              disabled={busy}
                            >
                              编辑
                            </button>
                            <button
                              className="btn btn-secondary"
                              onClick={() => deleteCustomSkillDraft(skill.name)}
                              disabled={busy}
                            >
                              删除
                            </button>
                          </div>
                        </div>
                        <p>{skill.description || '自定义技能'}</p>
                        <p className="clippy-skill-meta">
                          {skill.boundModel ? `绑定模型：${skill.boundModel}` : '未绑定模型'}
                        </p>
                      </article>
                    ))}
                  </div>
                )}
              </div>

              <div className="clippy-skill-list">
                <div className="clippy-mini-list-title">内置技能（只读）</div>
                {builtinSkillsOnly.length === 0 ? (
                  <p className="clippy-empty-state">暂无内置技能。</p>
                ) : (
                  <div className="clippy-skill-grid">
                    {builtinSkillsOnly.slice(0, 6).map((skill) => (
                      <article key={skill.name} className="clippy-skill-item">
                        <div className="clippy-skill-item-header">
                          <strong>{skill.name}</strong>
                        </div>
                        <p>{skill.description || '内置技能'}</p>
                        <p className="clippy-skill-meta">
                          {skill.tags.length ? `标签：${skill.tags.join(', ')}` : '无标签'}
                        </p>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </div>
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
              <div className="clippy-tools-header">
                <div className="clippy-tools-title">
                  AI 可执行建议
                  {mutatingActionCount > 0 ? `（变更待确认 ${mutatingActionCount}）` : ''}
                </div>
                <div className="clippy-tools-actions">
                  <button
                    className="btn btn-secondary"
                    onClick={executeAllSafeCommands}
                    disabled={busy || batchExecuting || safeActionCount === 0}
                  >
                    {batchExecuting ? '批量执行中...' : `执行全部只读(${safeActionCount})`}
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={clearSuggestedCommands}
                    disabled={busy || batchExecuting}
                  >
                    清空
                  </button>
                </div>
              </div>
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
                      disabled={busy || batchExecuting || item.status === 'running'}
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
                placeholder="问 Clippy：比如“我现在最该优化什么？”；技能：$skill code-review --model gpt-5-codex ...；Python：$py print(1)；能力：$mykey gateway.status"
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

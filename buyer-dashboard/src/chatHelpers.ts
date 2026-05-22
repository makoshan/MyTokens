import type { DashboardSnapshot, RoutingRuleRow } from './types.js'

export type ChatCapabilityId = 'mcp' | 'skills' | 'knowledge'

export interface ChatModelOption {
  model: string
  actualModel: string
  channelLabel: string
}

const CAPABILITY_LABELS: Record<ChatCapabilityId, string> = {
  mcp: 'MCP',
  skills: 'Skills',
  knowledge: 'Knowledge',
}

const CAPABILITY_PROMPTS: Record<ChatCapabilityId, string> = {
  mcp: 'MCP 已开启：如需外部工具或服务，请优先按工具调用意图组织回答，并说明需要的 MCP 服务。',
  skills: 'Skills 已开启：如任务适合固定流程，请先识别可用技能，再按技能步骤给出结果。',
  knowledge: 'Knowledge 已开启：优先利用当前会话与已给上下文，必要时说明缺少哪些资料。',
}

function isActiveRoutedRule(rule: RoutingRuleRow): boolean {
  return rule.status === 'active' && rule.requestedModel.trim().length > 0
}

export function buildChatModelOptions(snapshot: DashboardSnapshot): ChatModelOption[] {
  const activeChannels = new Map(
    snapshot.channels
      .filter((channel) => channel.status === 'active')
      .map((channel) => [channel.label, channel])
  )
  const byModel = new Map<string, ChatModelOption>()

  for (const rule of snapshot.routingRules) {
    if (!isActiveRoutedRule(rule)) continue
    const channel = activeChannels.get(rule.channelLabel)
    if (!channel) continue
    if (byModel.has(rule.requestedModel)) continue
    byModel.set(rule.requestedModel, {
      model: rule.requestedModel,
      actualModel: rule.actualModel || rule.requestedModel,
      channelLabel: channel.label,
    })
  }

  return [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model))
}

export function friendlyError(code: string): string {
  if (/insufficient|balance_too_low|balance_exhausted/i.test(code)) {
    return '余额不足，请先领取红包或充值后再试。'
  }
  if (code === 'account_paused' || code === 'account_not_found') return '账户不可用，请联系运营者。'
  if (code === 'model_required') return '请先选择一个模型。'
  if (code === 'no_healthy_route') return '这个模型还没有给当前账户开通可用路由，请让运营者刷新或添加该模型路由。'
  if (code === 'route_provider_adapter_mismatch' || code === 'provider_token_unavailable') {
    return '该模型当前不可用，运营者可能尚未共享或渠道异常。'
  }
  if (code.startsWith('provider_http_')) return `上游模型返回错误（${code}）。`
  if (code.startsWith('dashboard_auth')) return '会话已过期，请重新打开邀请链接。'
  return `请求失败：${code}`
}

export function capabilityLabel(id: ChatCapabilityId): string {
  return CAPABILITY_LABELS[id]
}

export function composeChatInput(prompt: string, enabled: ChatCapabilityId[]): string {
  const cleanPrompt = prompt.trim()
  if (enabled.length === 0) return cleanPrompt

  const capabilityBlock = enabled.map((id) => `- ${CAPABILITY_PROMPTS[id]}`).join('\n')
  return `可用能力：\n${capabilityBlock}\n\n用户消息：\n${cleanPrompt}`
}


import { useState } from 'react'
import { buildChatModelOptions } from '../chatHelpers.js'
import type { DashboardSnapshot } from '../types.js'
import { Button, Card, CardContent, PanelTitle } from '../token-ui.js'

export function Docs({ snapshot, baseUrl }: { snapshot: DashboardSnapshot; baseUrl: string }) {
  const models = buildChatModelOptions(snapshot)
  // Use a model the current account can actually route to, not a hardcoded one.
  const model = models[0]?.model ?? 'your-model'
  const hasModel = models.length > 0
  const keyPlaceholder = 'sk-mykey_live_你的KEY'

  const [copied, setCopied] = useState<string | null>(null)
  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500)
    } catch {
      setCopied(null)
    }
  }

  const claudeCodeEnv = [
    `export ANTHROPIC_BASE_URL=${baseUrl}`,
    `export ANTHROPIC_AUTH_TOKEN=${keyPlaceholder}`,
    `export ANTHROPIC_MODEL=${model}`,
    `claude`,
  ].join('\n')

  const anthropicCurl = [
    `curl ${baseUrl}/v1/messages \\`,
    `  -H "x-api-key: ${keyPlaceholder}" \\`,
    `  -H "anthropic-version: 2023-06-01" \\`,
    `  -H "content-type: application/json" \\`,
    `  -d '{"model":"${model}","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'`,
  ].join('\n')

  const openaiEnv = [
    `OPENAI_BASE_URL=${baseUrl}/v1`,
    `OPENAI_API_KEY=${keyPlaceholder}`,
    `# 模型: ${model}`,
  ].join('\n')

  const openaiCurl = [
    `curl ${baseUrl}/v1/chat/completions \\`,
    `  -H "Authorization: Bearer ${keyPlaceholder}" \\`,
    `  -H "content-type: application/json" \\`,
    `  -d '{"model":"${model}","messages":[{"role":"user","content":"你好"}]}'`,
  ].join('\n')

  return (
    <Card>
      <PanelTitle eyebrow="接入说明" title="怎么用这个网关" />
      <CardContent>
        <div className="doc-grid">
          <div>
            <span className="muted">Base URL</span>
            <code>{baseUrl}</code>
          </div>
          <div>
            <span className="muted">可用模型</span>
            <code>{hasModel ? model : '（运营者还没给你开通可用模型）'}</code>
          </div>
        </div>

        <p className="muted doc-intro">
          先到「MyKey API Key」页创建一个 key，把下面命令里的 <code>{keyPlaceholder}</code> 换成它（完整 key 只显示一次）。
          {hasModel ? '' : ' 当前账户暂无可路由模型，请让运营者刷新或添加模型路由。'}
        </p>

        <div className="doc-section">
          <div className="doc-section-head">
            <h3>① Claude Code（推荐 · Anthropic 接口）</h3>
            <Button variant="outline" size="sm" onClick={() => copy(claudeCodeEnv, 'cc')}>
              {copied === 'cc' ? '已复制 ✓' : '复制'}
            </Button>
          </div>
          <p className="muted">在终端里设置这三个环境变量后直接运行 <code>claude</code>，即可让 Claude Code 走这个网关。</p>
          <pre>{claudeCodeEnv}</pre>
          <div className="doc-section-head doc-section-subhead">
            <span className="muted">或直接用 curl 验证（Anthropic Messages）</span>
            <Button variant="outline" size="sm" onClick={() => copy(anthropicCurl, 'acurl')}>
              {copied === 'acurl' ? '已复制 ✓' : '复制'}
            </Button>
          </div>
          <pre>{anthropicCurl}</pre>
        </div>

        <div className="doc-section">
          <div className="doc-section-head">
            <h3>② 其它 OpenAI-compatible 客户端</h3>
            <Button variant="outline" size="sm" onClick={() => copy(openaiEnv, 'oai')}>
              {copied === 'oai' ? '已复制 ✓' : '复制'}
            </Button>
          </div>
          <p className="muted">
            Base URL 用 <code>{baseUrl}/v1</code>，鉴权用 MyKey API Key。注意：本网关共享的模型多为 Anthropic 风格，
            OpenAI 端点对这类模型可能返回 <code>route_provider_adapter_mismatch</code>——那种情况请用上面的 Claude Code / Messages 方式。
          </p>
          <pre>{openaiEnv}</pre>
          <div className="doc-section-head doc-section-subhead">
            <span className="muted">curl（OpenAI Chat Completions）</span>
            <Button variant="outline" size="sm" onClick={() => copy(openaiCurl, 'ocurl')}>
              {copied === 'ocurl' ? '已复制 ✓' : '复制'}
            </Button>
          </div>
          <pre>{openaiCurl}</pre>
        </div>
      </CardContent>
    </Card>
  )
}

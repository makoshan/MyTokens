# Compute Credit Gateway 实施计划

> **给 agentic workers：** 必须使用子技能：用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 按任务逐步实施本计划。任务使用 checkbox（`- [ ]`）语法跟踪状态。

**目标：** 构建一个 Cloudflare-first 的公网 Token/API Gateway。运营者只把“明确授权可以公开共享的上游 Token/API key”加密放入 Cloudflare Vault；外部 agent 通过统一 OpenAI-compatible API 调用服务。第一版使用 API key、手动 credit、余额扣费和单 provider relay 验证闭环；MPP/Tempo、USDC on-chain top-up 和 MYC 自发行 token 进入 v2/v3，在法律意见和 provider 商务许可明确后再启动。

**架构：** Cloudflare Worker 是唯一公网运行面。Worker 暴露 `/v1/responses` 等 compatible endpoints，Account Durable Object 负责余额锁、限额和幂等，D1 负责配置、ledger 镜像和报表，Queues 负责异步日志和分析。MyKey Desktop 从“本地 gateway/vault”改为“运营控制台 + 钱包”：它管理 Cloudflare admin API、钱包、token 授权导入、价格和账户，但不再作为公网请求路径。

**技术栈：** MyKey 桌面应用（React + TypeScript + Tauri/Rust）、Cloudflare Workers、Durable Objects、D1、Queues、Worker Secrets、envelope encryption、OpenAI-compatible HTTP APIs、provider adapters、admin API、wallet/passkey PRF。Tempo MPP、MYC 合约和 on-chain indexer 是后续扩展，不进入 v1 critical path。

---

## 产品方案

### 定位

MyKey Compute Gateway 是一个 private alpha 功能，面向希望把自己“可授权共享”的上游 Token/API key 统一加密托管到 Cloudflare，并通过一个受控 API 面向自己、朋友或受信 agent 使用的运营者。

面向用户的承诺：

> One Cloudflare API for authorized model and tool access. Metered, revocable, encrypted.

产品应该避免这些表述：

- 出售或泄露 OpenAI/Claude/translation/OCR 等上游 API keys。
- 出售投资型 token。
- 承诺 MYC 涨价、分红、回购或收益。
- 宣传可无限制公开转售上游模型访问能力。

第一版不把产品叙事建立在“公开出售模型访问能力”上。第一版验证的是：Cloudflare 统一入口、加密 token vault、API key 鉴权、余额 reserve/settle、Cloudflare usage/cost logging、streaming relay、运营控制台。公开收费、MPP、USDC、MYC 都必须等待 provider terms、商务授权和法律意见明确。

### 用户角色

- **Operator：** MyKey 所有者。负责选择哪些上游 tokens/API 可以进入 Cloudflare Vault，配置 provider、服务目录、价格、风控限制、账户和 admin 安全策略。
- **朋友 / 买家：** 可信用户或外部 agent operator。第一版通过 `dashboard.mykey.example` 接收邀请、查看余额/用量、创建或撤销 MyKey API key；credit 由 operator 手动授予。后续版本可以改为 USDC top-up、MPP 或 MYC。
- **Agent：** 使用 `Authorization: Bearer sk-mykey_*` 调用 `/v1/responses` 等 endpoint 的 bot 或 app。
- **高级 crypto 用户：** 后续版本中希望查看 MPP payment receipts、MYC payment vouchers、合约活动或手动管理 MYC 的用户。

### 用户心智模型

第一版普通用户看到：

- `API key`
- `Price per call`
- `Balance / credit`
- `Usage`
- `Invoices / receipts`

普通用户不需要理解：

- `mint`
- `burn`
- `redeem`
- `MYC`
- `MPP`
- 上游 API keys
- Token encryption、payment verification 和 settlement 内部逻辑

后续版本的高级用户可以打开 Advanced 面板查看：

- MYC 合约地址。
- MPP payment challenge。
- `Authorization: Payment` credential。
- Payment-Receipt header。
- Token 转账或 voucher 历史。

### 产品界面

#### MyKey 中的运营控制台

新增一个导航项：

- `Compute`

主卡片：

- 今日收入。
- 今日上游成本。
- 今日毛利。
- 活跃账户数。
- Gateway 健康状态。
- 未结算 reservations。
- 最近 manual credits。

Tabs：

- `Accounts`：买家、余额、API keys、模型 allowlists、预算、暂停状态。
- `Pricing`：售价、上游成本、毛利、模型可用性。
- `Token Vault`：只展示已授权进入 Cloudflare 的上游 tokens/API、provider scope、加密状态、轮换状态、最后调用时间。
- `Routing`：管理 requested model 到 provider token/channel 的规则、优先级、权重、model mapping 和 health 状态。
- `Credits`：manual credit/debit、ledger entries、reservations、退款和对账状态。
- `Payments`：v2/v3 使用，展示 MPP charges、MYC receipts、payment vouchers、确认状态。
- `Usage`：请求、token usage、成本、收入、错误、blocked requests。
- `Settings`：公网 gateway URL、admin endpoint、风控限制、admin auth、v2 treasury/链/合约地址。

#### 买家 Dashboard

第一版需要一个 Cloudflare-hosted dashboard，面向朋友/买家，而不是要求他们使用 MyKey Desktop。

```text
https://dashboard.mykey.example
```

入口流程：

```text
operator 在 MyKey Desktop 创建 account
  -> 生成一次性 invite link
  -> 朋友打开 dashboard
  -> 绑定 passkey 或创建 dashboard session
  -> 查看余额、用量、API key 和接入说明
```

Dashboard 页面：

- `Overview`：余额、今日用量、最近请求、当前状态。
- `Channels`：展示可用 provider/channel、模型列表、优先级、权重、延迟、错误率和状态；买家只能看透明状态，不能查看上游 token。
- `API Keys`：创建 key、撤销 key、查看 prefix/last4；完整 key 只在创建时显示一次。
- `Usage`：按时间、模型、endpoint 展示 token usage、费用和错误。
- `Model Quality`：展示模型身份检测、协议一致性、latency、tokens/sec、quality badge 和通道状态。
- `Credits`：查看 manual credit/debit ledger；第一版只能发起 credit request，不能自助付款。
- `Docs`：展示 Base URL、curl 示例、OpenAI-compatible client 示例和错误码。
- `Settings`：passkey/session 管理、account 名称、webhook 或通知偏好。

Dashboard 不能做：

- 查看或下载上游 provider token。
- 修改价格。
- 给自己手动加 credit。
- 访问 admin endpoints。
- 绕过 account allowlist、budget 或 pause。

生产级要求：

- Dashboard 默认必须从 `/dashboard/me`、`/dashboard/usage`、`/dashboard/api-keys` 等真实 API 加载数据。
- 未登录、session 失效或 API 失败时展示错误态，不允许静默回退到 mock/demo 数据。
- 本地预览数据只能通过显式 local-only preview mode 启用，例如 `127.0.0.1?preview=1`，不能进入 production build 的默认路径。
- Buyer Dashboard 只能展示脱敏 key prefix/last4、channel 状态、账单和模型质量，不展示上游 provider token、server pepper、master key 或 operator-only 成本字段。

#### 买家 API 体验

买家或 agent 第一版从 Dashboard 拿到公开 endpoint、MyKey API key、余额和服务价格。API key 是 v1 默认入口；MPP/402 是后续面向 accountless agent 的扩展。

```text
Base URL: https://api.mykey.example/v1
Auth: Authorization: Bearer sk-mykey_live_...
Payment: manual credit balance
```

第一次调用示例：

```bash
curl https://api.mykey.example/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-mykey_live_example" \
  -d '{"model":"gpt-5-mini","input":"hello"}'
```

如果账户没有余额，gateway 返回普通 API 错误，不在 v1 中立刻发起链上付款：

```http
402 Payment Required
{
  "error": {
    "message": "Insufficient compute credit.",
    "type": "payment_required",
    "code": "insufficient_credit"
  }
}
```

v2/v3 才考虑把这个响应升级为 MPP challenge，让 agent 使用 `Authorization: Payment ...` 重试同一请求。

风控错误：

```http
429 Too Many Requests
{
  "error": {
    "message": "Rate limit exceeded for this compute account.",
    "type": "rate_limit_error",
    "code": "account_rate_limited"
  }
}
```

### 定价模型

所有金额都使用整数 micro-units。

```text
1 USD-denominated service unit = 1,000,000 micro_usd
v2 optional: 1 MYC = 1 USD-denominated service unit by operator policy
v2 optional: 1 MYC = 1,000,000 micro_myc
```

每个模型包含：

```text
upstream_input_micro_usd_per_1m_tokens
upstream_output_micro_usd_per_1m_tokens
sell_input_micro_usd_per_1m_tokens
sell_output_micro_usd_per_1m_tokens
```

毛利：

```text
sell_cost - upstream_cost
```

v1 价格表只暴露 sell price，不暴露上游成本。MYC 售价只在 v2/v3 payment adapter 启用后暴露。

### 加密 Token Vault

只有运营者明确授权公开共享的上游 tokens/API 才进入 Cloudflare Gateway。默认不要把“运营者所有个人 tokens”自动上传到 Cloudflare。

可以进入 Cloudflare 的 token 类型包括：

- OpenAI API key。
- Anthropic API key。
- Gemini API key。
- 翻译 API key。
- OCR API key。
- 语音 API key。
- 图片生成 API key。
- 数据 API key。
- 未来其他可收费工具 token。

Token Vault 规则：

- Cloudflare Vault 只保存已授权公开共享的 token；未授权或只供本机使用的 token 保留在 MyKey Desktop 钱包/本地存储中，不进入公网运行面。
- 上游 token 永远不返回给买家或 agent。
- token 不以明文写入 D1。
- 第一版直接使用 envelope encryption：D1 只存 `ciphertext`、`nonce`、`key_version`、`provider_scope` 和 metadata。
- Master key 放在 Worker Secret 或外部 KMS；Worker Secrets 不直接保存每一个 provider token。
- Master key 必须有 `key_version`，支持新增版本、按 token 逐步重加密、旧版本只读、最终撤销。
- 需要 break-glass 流程：全局暂停、禁用 provider token、撤销 admin token、轮换 master key。
- Worker 只在内存中短暂解密 token，用于发起上游请求；Workers runtime 没有强 memory guarantee，这一点要作为 residual risk 记录。
- 日志、错误、analytics、queues payload 都必须 redacts upstream token。

助记词或 passkey PRF 的作用是派生 MyKey 自有密钥材料，例如 vault encryption key、admin signing key、compat API key。它们不能派生 OpenAI、Claude、Gemini、翻译、OCR 这类上游 provider token。上游 token 只能由运营者导入，然后加密保存和按需解密使用。

Cloudflare 统一接口对外暴露的是服务能力，不是 token 本身：

```text
encrypted upstream token -> provider adapter -> paid endpoint -> API key + credit -> response
```

### 未来扩展：付费 API Catalog

Gateway 应该被设计成一个 paid API catalog，而不只是 LLM proxy。

未来服务可以包括：

- Translation API。
- OCR API。
- 语音转写 API。
- 文本转语音 API。
- 图片生成 API。
- Embeddings API。
- 其他模型提供商。
- Data APIs。
- 运营者自定义工具。

通用产品抽象：

```text
service_id + endpoint + metering_unit + price + payment_method
```

示例：

```text
llm.responses        unit: input_token/output_token
translate.text       unit: source_word or source_character
ocr.image            unit: image or page
audio.transcribe     unit: audio_second
image.generate       unit: generated_image
embedding.create     unit: input_token
data.lookup          unit: request
```

#### Translation API 定价

对英语类语言，按单词计费更容易理解：

```text
$0.00002 per source word
```

对中文、日文、泰文以及没有可靠空格分词的语言，按字符计费更稳：

```text
$0.000004 per source character
```

推荐 v2 策略：

- 空格分词语言使用 `source_word`。
- CJK 和无空格语言使用 `source_character`。
- 管理后台同时展示两种价格。
- 在 ledger 中存储最终 billable unit count。

公开 endpoint：

```text
POST /v1/translate
```

请求：

```json
{
  "source_lang": "auto",
  "target_lang": "zh-CN",
  "text": "Hello world",
  "model": "default"
}
```

响应：

```json
{
  "translated_text": "你好，世界",
  "usage": {
    "source_words": 2,
    "source_characters": 11,
    "billable_unit": "source_word",
    "billable_units": 2
  }
}
```

#### 支付模式

v1 默认支持 balance mode。MPP 单次付费模式保留为 v2/v3 adapter，不作为第一版主路径。

Balance mode：

```text
manual credit -> sk-mykey_live_* -> reserve -> upstream call -> settle actual usage
```

这是第一版主路径，适合先验证 Cloudflare Worker、Account Durable Object、D1 ledger、usage parsing 和 streaming settle。

MPP charge mode：

```text
request -> 402 Payment Required challenge -> pay with MYC -> retry -> service response + Payment-Receipt
```

这是后续路径，适合翻译、OCR、短推理、数据 API 等可以在请求前估价或在请求后按固定单位结算的服务。

MPP session mode：

```text
open MYC payment session -> stream vouchers -> high-frequency calls or streaming tokens -> reconcile receipts
```

这是未来路径，适合 streaming LLM、token-by-token 付费、高频 agent tool calls。

MPP 是 HTTP-native 协议，围绕 `402 Payment Required` challenge-response 流程构建。公开生态仍早，不能把 v1 发布节奏押在 MPP/MYC 上。MYC 作为运营者自发行 token，只能在法律意见、provider 商务许可和 payment verifier 设计都明确后，通过 Tempo-compatible/custom payment method 接入。

参考：

- Dune MPP: https://docs.dune.com/api-reference/agents/mpp
- MPP services directory: https://mpp.dev/services
- Tempo protocol: https://docs.tempo.xyz/protocol

后续 MYC 获取方式可以是：

```text
USDC buy -> mint/transfer MYC -> agent pays per request with MYC
airdrop/invite -> receive MYC -> agent pays per request with MYC
manual grant -> receive MYC -> agent pays per request with MYC
```

MYC 不作为投资叙事，而是服务支付 token。后续 MYC UI 应展示“用 MYC 支付本次请求”，不要展示“价格会升值”。

### 发布范围

#### Private Alpha

- Cloudflare Worker 公网 gateway。
- 管理后台手动 credit/debit。
- 单 provider relay。
- 每账户 API keys。
- 每账户余额。
- OpenAI-compatible `/v1/responses`，包含 streaming 和 provider final usage event 解析。
- 基础 token usage parsing。
- 手动暂停和全局 circuit breaker。
- 仅供运营者自己和受信用户使用，不做公开出售。

#### Private Beta

- 通过 provider 商务许可后支持受控多账户。
- 可选 USDC top-up，但不发行 MYC。
- Translation API。
- MPP charge adapter beta。
- 面向 Claude-compatible clients 的 `/v1/messages`。
- 买家可见的 balance 和 usage endpoint。

#### Advanced Beta

- MYC 合约，前提是法律意见允许。
- Advanced MYC visibility。
- 朋友之间转移 compute credit。
- Invite credits 和 airdrops。
- 多 provider routing。
- Cloudflare AI Gateway 作为可选上游 observability layer。

### 第一版非目标

- 不做任意用户可列出自己上游 API keys 的公开 marketplace。
- 不给 MYC 提供 DEX liquidity。
- 不提供 token price chart。
- 不做 yield、staking、dividends 或 buyback 机制。
- 不开放无限制匿名使用。
- 不把当前本地 Tauri gateway 直接暴露到公网。
- 不把 local gateway 作为 v1 运行依赖。
- 不为了公网 relay 去改造 `src-tauri/src/gateway.rs`。

### Policy 和条款边界

产品应该把自己呈现为托管推理服务。运营者不得出售、出租、转让或泄露上游 provider keys。

相关官方参考：

- OpenAI Services Agreement: https://openai.com/policies/services-agreement/
- Anthropic Commercial Terms: https://www.anthropic.com/legal/commercial-terms
- SEC crypto asset transactions: https://www.sec.gov/resources-small-businesses/capital-raising-building-blocks/transactions-involving-crypto-assets
- FinCEN virtual currency guidance: https://www.fincen.gov/resources/statutes-regulations/guidance/application-fincens-regulations-persons-administering
- Cloudflare Durable Objects: https://developers.cloudflare.com/durable-objects/
- Cloudflare D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- Cloudflare Worker Secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- Cloudflare AI Gateway: https://developers.cloudflare.com/ai-gateway/

## 当前代码上下文

当前 MyKey repo 已经有一些可参考的基础，但 Cloudflare Gateway 不复用 local gateway 热路径：

- `src-tauri/src/gateway.rs` 中的本地 gateway runtime，只作为兼容行为参考，不作为 Cloudflare relay 基础。
- `src-tauri/src/vault.rs` 中的 app route token resolution。
- 带 token 和 cost 字段的 gateway request logs。
- 带 `input_price` 和 `output_price` 的 provider models。
- 已经理解 gateway traffic 和 budget 的 Dashboard 与 settings 界面。
- Crypto wallet UI 以及 chain/account 概念。

重要约束：

- Cloudflare Worker 是 v1 唯一公网运行面。
- 当前 local gateway 可以继续绑定 `127.0.0.1`，但不再是本计划的基础约束。
- `resolve_gateway_route_by_token` 当前只检查本地 `claude-code` 和 `codex` app tokens。
- `/v1/chat/completions` 当前映射到 Codex relay 行为，不是通用公网 OpenAI provider relay。
- Cloudflare provider-neutral relay 必须新建，不应通过改造 local gateway 得到。
- `AGENTS.md` 中列出的产品 spec 路径在当前 checkout 中不存在：`/Users/thursday/go/play/mykey/Docs_code/Mykey 产品文档.md`。如果该文件恢复，实施前需要将本计划与它对照。

## 中转站参考调研

调研对象：

- `songquanpeng/one-api`：https://github.com/songquanpeng/one-api/tree/8df4a2670b98266bd287c698243fff327d9748cf
- `Buywatermelon/claude-relay-monorepo`：https://github.com/Buywatermelon/claude-relay-monorepo/tree/4e5cbc417e1883f0b860aff2f70130681d39c08e
- `basketikun/chatgpt2api`：https://github.com/basketikun/chatgpt2api/tree/4a63f87f276360442bdadf8601397f8767dba2c9
- `zzsting88/relayAPI`：https://github.com/zzsting88/relayAPI/tree/31a366a261998125c87649f2c02f0fc7e9f1b0ac

### `one-api` 的可借鉴点

`one-api` 最接近成熟中转站模型。它的核心不是单纯 proxy，而是：

```text
buyer token -> user/account quota -> channel -> ability routing -> adaptor relay -> pre/post consume -> logs/monitor
```

可直接映射到 MyKey：

```text
one-api Token       -> MyKey API Key
one-api User        -> MyKey Account
one-api Channel     -> Encrypted Provider Token
one-api Ability     -> Routing Rule
one-api Quota       -> Credit Balance
one-api Log         -> Usage Ledger
one-api Relay       -> Cloudflare Worker Adapter
```

需要吸收的设计：

- API key 不是简单 bearer token，还要有额度、过期时间、允许模型、IP/subnet 限制和状态。
- 上游 provider token 应被建模成 channel：provider type、base URL、模型列表、状态、优先级、权重、model mapping、已用额度和健康状态。
- 路由不能只靠 `provider + model`，应该有类似 `group + model -> channel/provider_token` 的能力表。
- 请求热路径需要 `preConsumeQuota` 和 `postConsumeQuota`：上游前预扣，拿到 usage 后结算，多退少补。
- 上游错误要反馈到 channel/token 健康状态：401/403/余额不足等错误自动禁用，429/exhausted 自动冷却。
- 日志必须可按 user、token、model、channel、时间查询，用来支撑账单和争议处理。
- UI 信息架构可以参考 `one-api`：左侧主导航，核心页面是总览、渠道、令牌、日志、额度、设置；页面内部以搜索栏、批量操作、分页表格和状态标签为主，不做营销页。
- UI 组件和视觉 token 可以参考 `consenlabs/token-ui`：优先使用 Button、Card、Badge、Table、Sidebar 这类组件抽象，以及 imToken Design System 的蓝色主操作、柔和卡片、pill button、语义 badge 和资产工具感。

MyKey 不应照搬的点：

- `one-api` 是传统 Go server + DB，不是 Cloudflare-first。
- 它的 channel key 是普通数据库字段；MyKey 必须使用 envelope encryption。
- 它的内部 quota 是点数倍率；MyKey v1 应使用 `micro_usd`，MYC 只作为 v2/v3 映射。
- 它是大而全平台；MyKey v1 应先保持 `/v1/responses` 单 provider relay。

### `claude-relay-monorepo` 的可借鉴点

`claude-relay-monorepo` 的结构适合学习 provider relay 分层：

```text
route -> proxy service -> engine -> provider resolver -> model router -> key pool -> transformer -> response wrapper
```

需要吸收的设计：

- `ProviderResolver` 负责一次性解析 provider、模型、API key 和 transformer，避免 relay handler 到处查配置。
- `ModelRouter` 可以根据长上下文、thinking、web search、后台模型等请求特征选模型。
- `KeyPool` 把 active、exhausted、error、disabled、success/failure stats 和 recovery interval 放在一起。
- `Transformer` 明确负责协议转换，例如 Claude request 转 OpenAI-compatible request。
- `ResponseWrapper` 统一处理 JSON 和 SSE stream response headers。

MyKey v1 只需要吸收分层，不要过早实现复杂 transformer。第一版优先：

```text
OpenAI-compatible request -> OpenAI official adapter -> OpenAI-compatible response
```

Claude、Gemini、跨协议转换和多 provider fallback 放到 v2。

### `chatgpt2api` 的可借鉴点和边界

`chatgpt2api` 做得完整的是 OpenAI-compatible API surface、账号池、流式包装、日志和图片能力。它的风险也很明确：它依赖 ChatGPT Web 后端逆向，不适合作为 MyKey 的商业化实现路线。

可以借鉴：

- API surface 覆盖 `/v1/models`、`/v1/responses`、`/v1/chat/completions`、`/v1/messages` 和 image endpoints。
- 账号池有可用性、额度、限流、并发槽位、异常 token 移除和定时刷新。
- 日志围绕 endpoint、model、key、duration、status、request excerpt 和 streaming end/failure 展开。
- 流式 handler 会先拉取第一条事件，尽早发现 upstream 错误，再决定返回 SSE。

不能借鉴：

- 不做 Web 端逆向。
- 不绕过 provider 官方 API 或条款。
- 不把用户重要账号作为账号池消耗品。

### `relayAPI` 的可借鉴点

`relayAPI` 不是中转站后端，而是中转站评测/鉴定工具和推荐文档。它对 MyKey 的启发是“如何让买家相信这个中转站没有掺水、账单不黑箱、接口质量稳定”。

需要吸收为 Buyer Dashboard 能力：

- `Model Quality` 或 `Authenticity Check`：对某个 model/channel 运行探测，展示协议一致性、响应结构、身份一致性、知识问答、签名指纹、latency、tokens/sec、input/output tokens。
- 每个模型展示 quality badge：`trusted`、`mostly reliable`、`degraded`、`suspicious`。
- 账单页展示每次请求的 request id、model、endpoint、input/output tokens、费用、latency、status 和 error。
- 价格页明确 input/output 单价、计费单位、缓存/thinking/tool/image 的计费规则。
- 状态页展示 provider/channel 是否 degraded、exhausted、paused 或 quota near limit。

做得好的中转站的产品特征：

- 稳定性可证明：有状态页、可用率、延迟、错误率和公告。
- 模型不掺水：模型身份、协议和能力表现可验证。
- 价格透明：input/output 单价、倍率、特殊计费项和最低扣费都清楚。
- 账单可追溯：每次请求都能查 request id、tokens、费用和错误。
- 渠道分层清楚：官方、反代、低价、高质量渠道不能混在一起卖。
- 风控成熟：API key 可撤销，支持模型/IP/预算/速率限制，异常 channel 自动暂停。
- 信任机制：文档清楚、小额试用、客服/状态通知、异常处理流程明确。

### MyKey 的结论

MyKey 的中转站核心应被定义为：

```text
API Key 额度系统
+ Encrypted Provider Token / Channel 系统
+ Routing Rule 系统
+ Adapter Relay 系统
+ Reserve/Settle 计费系统
+ Buyer Dashboard 透明账单和质量检测
```

v1 主链路：

```text
POST /v1/responses
  -> authenticate sk-mykey_*
  -> load account + group
  -> check balance / model allowlist / rate limit
  -> resolve routing rule
  -> select encrypted provider token
  -> reserve credit in Account DO
  -> decrypt provider token in Worker memory
  -> call upstream official API
  -> stream response
  -> parse usage
  -> settle credit
  -> write ledger/log
  -> update provider token health
```

## 技术方案

### 部署架构

```mermaid
flowchart LR
  Buyer["Buyer / Agent"] -->|"Authorization: Bearer sk-mykey_*"| CF["Cloudflare Worker public API"]
  BuyerUI["Buyer Dashboard"] -->|"dashboard session"| Dash["dashboard.mykey.example"]
  Dash --> CF
  CF --> WAF["Cloudflare WAF / Rate Limits"]
  CF --> AccountDO["Account Durable Object"]
  AccountDO --> DOStore["Balance locks + idempotency + rate windows"]
  CF --> D1["D1 metadata + analytics"]
  CF --> Router["Routing Engine / Model Mapping"]
  Router --> Vault["Encrypted Token Vault"]
  Router --> Upstream["OpenAI / Anthropic / Gemini / Translation APIs"]
  CF --> Queue["Queues: logs + analytics"]
  Queue --> D1
  Desktop["MyKey Desktop Console + Wallet"] -->|"admin API"| Admin["admin.api.mykey.example"]
  Admin --> CF
```

### Cloudflare 组件

#### Buyer Dashboard

职责：

- 面向朋友/买家展示 account balance、usage、ledger、API keys 和接入文档。
- 接收一次性 invite link，并绑定 passkey、magic link 或 dashboard session。
- 允许买家创建和撤销自己的 API keys，但完整 key 只显示一次。
- 允许买家发起 credit request，等待 operator 在 MyKey Desktop 或 admin API 中批准。
- 展示模型质量、通道状态、延迟、tokens/sec 和最近异常，避免买家感觉中转站是黑箱。
- 不暴露 admin controls、上游 provider tokens、上游成本和全局价格配置。

第一版可以用 Cloudflare Pages 部署 React/Vite dashboard，并通过 Worker 的 dashboard API 读写 D1/DO。

#### Worker

职责：

- 公开 OpenAI-compatible API。
- API key authentication，用于 buyer、admin、白名单和兼容模式。
- Dashboard session authentication，用于 buyer dashboard。
- 管理端走 `admin.api.mykey.example`，并使用 mTLS、IP allowlist 或等价强保护。
- v2/v3 才启用 MPP `402 Payment Required` challenge 和 `Authorization: Payment` credential verification。
- 路由 provider requests。
- 调用 Account Durable Object 完成 balance reserve、rate limit 和幂等校验。
- 将请求转发给上游模型 providers。
- 解析 usage。
- 返回 provider-compatible responses。
- 将 request logs 和 analytics jobs 入队。

使用 Worker Secrets 存储 master encryption key、server pepper 和内部 admin signing secrets。上游 API key 本体使用 envelope encryption 保存。

#### Routing Engine

职责：

- 将 buyer 请求中的 `model` 映射到可用的 provider token/channel。
- 支持 `account_group + requested_model -> provider_token_id + actual_provider_model` 的路由规则。
- 支持 priority、weight、health status 和短暂 cooldown。
- 支持 model mapping，例如外部展示 `gpt-4.1-mini`，内部调用某个 provider 的等价模型。
- 上游 token 出现 401/403、quota exhausted、429 spike 或连续 5xx 时，更新 provider token health。
- 不做买家不可见的降级掺水：如果实际模型和展示模型不同，Dashboard 和 pricing/docs 必须明确标注。

v1 可以只配置一条默认路由，但数据模型必须保留 routing rule 概念。这样后续从单 provider 扩展到多 provider、Claude、Gemini 或翻译 API 时，不需要重写计费和日志主链路。

#### Encrypted Token Vault

职责：

- 保存运营者明确授权公开共享的上游 tokens/API。
- 为每个 token 记录 provider、scope、adapter、状态、轮换时间和最后调用时间。
- 通过 envelope encryption 防止 D1 明文泄露。
- 只允许 provider adapter 在请求执行时解密使用。
- 支持 token pause、rotate、delete 和 emergency revoke。

第一版实现建议：

```text
all authorized provider tokens -> D1 ciphertext + nonce + key_version
master key -> Worker Secret or external KMS
operator local backup -> MyKey Desktop wallet/vault, not public request path
```

Master key rotation：

```text
create new key_version -> encrypt new tokens with new version -> background rewrap old ciphertext -> mark old key read-only -> revoke old key after audit window
```

Break-glass：

```text
global pause -> disable provider adapters -> revoke admin sessions -> rotate server pepper/master key if needed -> audit D1/Queues logs for leakage
```

#### Durable Objects

每个 compute account 使用一个 Account Durable Object。

职责：

- 强一致 balance reserve/settle。
- Idempotency key replay protection。
- 每账户 rate limits。
- 每账户 recent usage windows。
- 幂等 ledger application。
- Account pause state cache。

Durable Object storage 是热路径中 balance lock、rate limit 和 request state 的事实来源。D1 接收镜像 ledger entries，用于 admin 查询和报表。

#### D1

职责：

- Account registry。
- API key hash registry。
- Model price book。
- Routing rules 和 model allowlists。
- Provider token health mirror。
- 全局 analytics。
- 镜像 ledger entries。
- Chain event records。
- Admin audit log。

D1 不作为热路径 balance lock，因为单个 D1 database 会串行处理 queries。但它非常适合 indexed reporting 和 configuration。

#### Queues

职责：

- 异步写 request logs。
- Chain event processing。
- Analytics aggregation。
- 可重试 webhook/indexer events。

### 数据模型

#### D1 Tables

v1 只需要 accounts、api_keys、account_invites、dashboard_sessions、credit_requests、price_book、routing_rules、model_allowlist、ledger、request_logs、provider_tokens 和 audit_logs。services、metering_rules、mpp_sessions、mpp_charges、chain_events 是 v2/v3 扩展表，先写在这里是为了避免未来账本结构返工。

注意：所有 partial unique index 在落地迁移前必须用当前 Cloudflare D1 版本实际验证；如果 D1 行为不满足预期，改用显式 idempotency table。

`compute_provider_tokens`

```sql
CREATE TABLE compute_provider_tokens (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  adapter TEXT NOT NULL,
  base_url TEXT,
  models_json TEXT,
  status TEXT NOT NULL,
  scope_json TEXT,
  secret_ref TEXT,
  ciphertext TEXT,
  nonce TEXT,
  key_version TEXT,
  derivation_fingerprint TEXT,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  exhausted_until TEXT,
  last_error TEXT,
  last_response_ms INTEGER,
  last_used_at TEXT,
  rotated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_compute_provider_tokens_provider ON compute_provider_tokens(provider);
CREATE INDEX idx_compute_provider_tokens_status ON compute_provider_tokens(status);
CREATE INDEX idx_compute_provider_tokens_exhausted ON compute_provider_tokens(exhausted_until);
```

`compute_accounts`

```sql
CREATE TABLE compute_accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  owner_wallet TEXT,
  status TEXT NOT NULL,
  account_group TEXT NOT NULL DEFAULT 'default',
  default_provider TEXT NOT NULL,
  default_model TEXT,
  daily_budget_micro_usd INTEGER,
  rpm_limit INTEGER,
  tpm_limit INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`compute_api_keys`

```sql
CREATE TABLE compute_api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT,
  key_prefix TEXT NOT NULL,
  key_last4 TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL DEFAULT 'compat_api',
  derivation_mode TEXT NOT NULL DEFAULT 'random',
  derivation_fingerprint TEXT,
  derivation_index INTEGER,
  ip_allowlist_json TEXT,
  model_allowlist_json TEXT,
  rpm_limit INTEGER,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY(account_id) REFERENCES compute_accounts(id)
);
CREATE INDEX idx_compute_api_keys_hash ON compute_api_keys(key_hash);
CREATE INDEX idx_compute_api_keys_account ON compute_api_keys(account_id);
```

`compute_account_invites`

```sql
CREATE TABLE compute_account_invites (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  invite_token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES compute_accounts(id)
);
CREATE INDEX idx_compute_invites_account ON compute_account_invites(account_id);
```

`compute_dashboard_sessions`

```sql
CREATE TABLE compute_dashboard_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  session_hash TEXT NOT NULL UNIQUE,
  auth_method TEXT NOT NULL,
  passkey_credential_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY(account_id) REFERENCES compute_accounts(id)
);
CREATE INDEX idx_compute_dashboard_sessions_account ON compute_dashboard_sessions(account_id);
```

`compute_credit_requests`

```sql
CREATE TABLE compute_credit_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  requested_micro_usd INTEGER NOT NULL,
  message TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  FOREIGN KEY(account_id) REFERENCES compute_accounts(id)
);
CREATE INDEX idx_compute_credit_requests_account ON compute_credit_requests(account_id, created_at);
```

`compute_price_book`

```sql
CREATE TABLE compute_price_book (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream_input_micro_usd_per_1m_tokens INTEGER NOT NULL,
  upstream_output_micro_usd_per_1m_tokens INTEGER NOT NULL,
  sell_input_micro_usd_per_1m_tokens INTEGER NOT NULL,
  sell_output_micro_usd_per_1m_tokens INTEGER NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, model, version)
);
```

`compute_routing_rules`

```sql
CREATE TABLE compute_routing_rules (
  id TEXT PRIMARY KEY,
  account_group TEXT NOT NULL DEFAULT 'default',
  requested_provider TEXT,
  requested_model TEXT NOT NULL,
  provider_token_id TEXT NOT NULL,
  actual_provider_model TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  model_mapping_json TEXT,
  quality_label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(provider_token_id) REFERENCES compute_provider_tokens(id)
);
CREATE INDEX idx_compute_routing_rules_group_model ON compute_routing_rules(account_group, requested_model, status);
CREATE INDEX idx_compute_routing_rules_provider_token ON compute_routing_rules(provider_token_id);
```

`compute_model_allowlist`

```sql
CREATE TABLE compute_model_allowlist (
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, provider, model),
  FOREIGN KEY(account_id) REFERENCES compute_accounts(id)
);
```

`compute_ledger_entries`

```sql
CREATE TABLE compute_ledger_entries (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount_micro_usd INTEGER NOT NULL,
  balance_after_micro_usd INTEGER,
  provider TEXT,
  model TEXT,
  request_id TEXT,
  reservation_id TEXT,
  chain_id INTEGER,
  tx_hash TEXT,
  log_index INTEGER,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES compute_accounts(id)
);
CREATE INDEX idx_compute_ledger_account_created ON compute_ledger_entries(account_id, created_at);
CREATE UNIQUE INDEX idx_compute_ledger_chain_event ON compute_ledger_entries(chain_id, tx_hash, log_index)
  WHERE tx_hash IS NOT NULL AND log_index IS NOT NULL;
```

`compute_request_logs`

```sql
CREATE TABLE compute_request_logs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  api_key_id TEXT,
  provider_token_id TEXT,
  routing_rule_id TEXT,
  created_at TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  endpoint TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  billable_unit TEXT,
  billable_units INTEGER,
  sell_cost_micro_usd INTEGER,
  upstream_cost_micro_usd INTEGER,
  blocked_reason TEXT,
  error_code TEXT,
  request_hash TEXT,
  FOREIGN KEY(account_id) REFERENCES compute_accounts(id)
);
CREATE INDEX idx_compute_logs_account_created ON compute_request_logs(account_id, created_at);
CREATE INDEX idx_compute_logs_provider_model ON compute_request_logs(provider, model);
CREATE INDEX idx_compute_logs_route ON compute_request_logs(provider_token_id, routing_rule_id);
```

`compute_services`（v2）

```sql
CREATE TABLE compute_services (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  default_provider TEXT,
  default_model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`compute_metering_rules`（v2）

```sql
CREATE TABLE compute_metering_rules (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  unit_type TEXT NOT NULL,
  price_micro_usd_per_unit INTEGER NOT NULL,
  minimum_charge_micro_usd INTEGER NOT NULL,
  language_policy_json TEXT,
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(service_id) REFERENCES compute_services(id)
);
```

`compute_mpp_sessions`（v2/v3）

```sql
CREATE TABLE compute_mpp_sessions (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  payer_wallet TEXT,
  payment_network TEXT NOT NULL,
  status TEXT NOT NULL,
  authorized_micro_usd INTEGER NOT NULL,
  spent_micro_usd INTEGER NOT NULL,
  expires_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(service_id) REFERENCES compute_services(id)
);
```

`compute_mpp_charges`（v2/v3）

```sql
CREATE TABLE compute_mpp_charges (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  account_id TEXT,
  payer_wallet TEXT,
  payment_network TEXT NOT NULL,
  payment_token TEXT NOT NULL,
  amount_micro_myc INTEGER NOT NULL,
  intent TEXT NOT NULL,
  status TEXT NOT NULL,
  request_hash TEXT,
  payment_credential_hash TEXT,
  payment_receipt TEXT,
  created_at TEXT NOT NULL,
  verified_at TEXT,
  FOREIGN KEY(service_id) REFERENCES compute_services(id),
  FOREIGN KEY(account_id) REFERENCES compute_accounts(id)
);
CREATE UNIQUE INDEX idx_compute_mpp_charges_credential ON compute_mpp_charges(payment_credential_hash)
  WHERE payment_credential_hash IS NOT NULL;
```

`compute_chain_events`（Advanced Beta）

```sql
CREATE TABLE compute_chain_events (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  account_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  amount_usdc_units INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  error_message TEXT,
  UNIQUE(chain_id, tx_hash, log_index)
);
```

`compute_admin_audit_log`

```sql
CREATE TABLE compute_admin_audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
```

#### Durable Object State

每个 account object 存储：

```text
account_id
balance_micro_usd
reserved_micro_usd
status
daily_budget_micro_usd
spent_today_micro_usd
rpm_limit
tpm_limit
config_version
recent_request_buckets
idempotency_keys
open_reservations
```

D1 中的 account row 是配置事实来源；Durable Object 缓存运行态和 `config_version`。Admin 更新限额、模型 allowlist 或暂停状态后，必须向对应 Account DO 发送 config refresh 或让 DO 在下一次请求前发现版本变化。

Reservation object：

```text
reservation_id
request_id
account_id
estimated_micro_usd
status: open | settled | refunded | expired
provider
model
created_at
expires_at
```

### API Key 设计

API key 是 MyKey 自己的 gateway key，只用于 MyKey Cloud Gateway、admin API、OpenAI-compatible fallback 和余额兼容模式。它不是上游 provider token，也不应该被当作 OpenAI/Claude key 暴露给用户。

公开格式：

```text
sk-mykey_live_<random>
sk-mykey_test_<random>
```

默认 buyer key 使用随机数生成，便于撤销和轮换。高级模式可以从 crypto wallet、助记词或 passkey PRF 派生，但派生出来的仍然是 MyKey gateway key：

```text
root_secret = BIP39Seed(mnemonic, optional_passphrase)
or
root_secret = PasskeyPRF(prf_salt)

api_key_bytes = HKDF-SHA256(
  root_secret,
  salt = "mykey gateway api key v1",
  info = "account:<account_id>:scope:<scope>:index:<index>",
  length = 32
)

api_key = "sk-mykey_live_" + base64url(api_key_bytes)
```

建议使用 domain-separated paths，避免同一份 root material 被混用：

```text
mykey/gateway/api-key/v1/account/<account_id>/index/<n>
mykey/admin/signing/v1
mykey/vault/encryption/v1
mykey/mpp/payment/v1
```

Cloud 侧只保存可验证材料和派生指纹，不接收助记词、passkey PRF root secret 或 vault encryption key：

```text
key_prefix
key_last4
key_hash = HMAC_SHA256(server_pepper, raw_api_key)
account_id
scope
ip_allowlist_json
model_allowlist_json
expires_at
derivation_mode
derivation_fingerprint
derivation_index
status
created_at
revoked_at
```

验证流程：

```text
Authorization: Bearer sk-mykey_live_xxx
  -> Worker computes HMAC_SHA256(server_pepper, raw_api_key)
  -> lookup compute_api_keys
  -> status is active
  -> allow compatible API path
```

设计规则：

- 派生式 API key 仍然需要 registry row，否则无法 revoke、rotate、限制模型、限额和审计。
- 运营者 admin key 可以从本地助记词或 passkey PRF 派生。
- 普通 buyer key 第一版默认随机生成，减少丢失 root secret 或重复派生带来的风险。
- 如果 buyer 想要 wallet-native recovery，可以开启 derived key mode。
- MPP 付费凭证应优先使用钱包签名或 payment credential，不把 bearer API key 当作支付资产。
- 上游 provider token 由 vault encryption key 加密保存，而不是从助记词或 passkey PRF 派生。
- `server_pepper` 轮换会导致现有 API key hash 无法验证；除非采用 pepper version + dual-read migration，否则 UI 必须把 pepper 轮换解释为“全量 API key 失效，需要重新签发”。

### Public API

Buyer endpoints：

```text
GET  /health
GET  /v1/models
GET  /v1/pricing
GET  /v1/balance
GET  /v1/usage
POST /v1/responses
```

Buyer dashboard endpoints：

```text
POST /dashboard/invites/:token/accept
POST /dashboard/sessions
DELETE /dashboard/sessions/current
GET  /dashboard/me
GET  /dashboard/balance
GET  /dashboard/usage
GET  /dashboard/ledger
GET  /dashboard/model-quality
POST /dashboard/model-quality/probes
GET  /dashboard/api-keys
POST /dashboard/api-keys
POST /dashboard/api-keys/:id/revoke
POST /dashboard/credit-requests
```

Dashboard endpoints 使用 dashboard session cookie 或 passkey-backed session，不接受 admin token。API key 可以调用 `/v1/*`，但默认不能登录 Dashboard；避免把长期 bearer key 同时当作网页 session。

v2/v3 endpoints：

```text
POST /v1/chat/completions
POST /v1/messages
POST /v1/translate
POST /v1/ocr
POST /v1/audio/transcriptions
POST /v1/images/generations
```

Admin endpoints：

```text
GET    /admin/accounts
POST   /admin/accounts
PATCH  /admin/accounts/:id
POST   /admin/accounts/:id/api-keys
POST   /admin/accounts/:id/invites
POST   /admin/invites/:id/revoke
POST   /admin/api-keys/:id/revoke
POST   /admin/accounts/:id/manual-credit
GET    /admin/credit-requests
POST   /admin/credit-requests/:id/approve
POST   /admin/credit-requests/:id/reject
GET    /admin/ledger
GET    /admin/usage
GET    /admin/top-ups
GET    /admin/pricing
PUT    /admin/pricing/:id
GET    /admin/provider-tokens
POST   /admin/provider-tokens
PATCH  /admin/provider-tokens/:id
POST   /admin/provider-tokens/:id/rotate
GET    /admin/routing-rules
PUT    /admin/routing-rules/:id
POST   /admin/model-quality/probes
GET    /admin/services
PUT    /admin/services/:id
PUT    /admin/metering-rules/:id
POST   /admin/circuit-breaker
```

Admin endpoints 需要独立的 operator auth token。它们不能接受 buyer API keys。生产环境建议使用独立域名 `admin.api.mykey.example`，叠加 mTLS、IP allowlist 或等价强保护。

### 请求流程

```text
1. 提取 Authorization Bearer token。
2. 对 token 做 hash，在 D1 中查找 compute_api_keys row。
3. 拒绝 missing、revoked、inactive 或 paused accounts。
4. 从 request 和 price book 中解析 provider/model。
5. 检查 account model allowlist。
6. 根据 account_group 和 requested model 解析 routing rule。
7. 选择 health 可用的 provider token/channel，并得到 actual provider model。
8. 估算最大可能 sell cost。
9. 向 Account Durable Object 发送 reserve request。
10. 解密 provider token，并将请求转发给 upstream provider。
11. 从响应中解析 usage。
12. 计算实际 sell cost 和 upstream cost。
13. 向 Account Durable Object 发送 settle request。
14. 将 request log 入队，并更新 provider token health。
15. 返回 upstream-compatible response。
```

### Reserve 和 Settle 规则

估算：

```text
estimated_input_tokens = prompt/input tokens if cheaply known, otherwise conservative floor
estimated_output_tokens = request.max_tokens or max_output_tokens, capped by model policy
estimated_cost = input_price * estimated_input_tokens + output_price * estimated_output_tokens
minimum_reserve = account minimum, for example 0.01 USD
reserve_amount = max(estimated_cost, minimum_reserve)
```

Settle：

```text
actual_cost = parsed_input_cost + parsed_output_cost
if actual_cost <= reserve_amount:
  settle reserve and refund difference
else:
  settle reserve and debit additional amount if balance allows
```

如果 upstream call 在生成 token 前失败：

```text
refund full reservation
```

如果 upstream 返回 provider error 且可能已经部分生成：

```text
settle using reported usage when available
refund if no usage is reported
```

### Streaming 策略

Private Alpha：

- 将 chunks stream 给 client。
- 当 provider 发出 final SSE usage event 时解析它。
- 如果没有 usage event，使用配置的保守估算 settle，并在 log 中标记 `estimated_usage`。
- 如果某个 provider/model 无法稳定返回 final usage，默认 fail closed：该 model 的 streaming 暂停，只允许 non-streaming 或更高 reservation 的 operator-only 模式。

Private Beta：

- 增加跨 provider streaming usage reconciliation。
- 支持 provider usage API 对账。
- 支持 MPP session 或其他 streaming payment primitive。

### Provider Relay

不要复用当前 Codex-specific relay 处理公网买家流量。

在 cloud gateway 中创建 provider-neutral relay code：

- `relayOpenAIResponses`
- `relayOpenAIChatCompletions`
- `relayClaudeMessages`
- `resolveRoutingRule`
- `selectProviderToken`
- `parseOpenAIUsage`
- `parseAnthropicUsage`
- `normalizeProviderError`

Provider secrets 使用 envelope encryption 存放，master key 在 Worker Secret 或外部 KMS。Buyer keys 永远不会到达 upstream providers。

### MYC 合约计划

MYC 不属于 v1。只有在法律意见、provider 商务许可和 payment verifier 设计都明确后，才进入 Advanced Beta。

Network：

- 候选：Base，或 Tempo MPP 支持最顺的 EVM 网络。
- Payment token：运营者发行的 MYC，建议 6 decimals，便于和 `micro_myc` 计费单位对齐。
- Unit policy：`1 MYC = 1 USD-denominated service unit`，这是运营者的价格口径，不是对外投资承诺。
- USDC role：USDC 只作为可选购买入口或 treasury settlement，不是用户每次调用 API 的默认付费资产。

面向用户的 top-up：

```solidity
function topUpWithUSDC(uint256 amount, bytes32 gatewayAccountId) external;
```

高级函数：

```solidity
function buyWithUSDC(uint256 amount, address recipient) external;
function redeem(uint256 amount, bytes32 gatewayAccountId) external;
function pause() external;
function unpause() external;
function setWhitelist(address user, bool allowed) external;
function withdrawUSDC(address to, uint256 amount) external;
```

Events：

```solidity
event Purchased(address indexed buyer, address indexed recipient, uint256 amount);
event Redeemed(address indexed user, bytes32 indexed gatewayAccountId, uint256 amount);
event WhitelistSet(address indexed user, bool allowed);
event TreasuryWithdraw(address indexed to, uint256 amount);
```

默认 UX 路径：

```text
topUpWithUSDC 或 buyWithUSDC
  -> transfer USDC from user to contract
  -> mint MYC
  -> optional immediate redeem
  -> burn MYC if redeemed for gateway usage
  -> emit Redeemed
```

高级 UX 路径：

```text
buyWithUSDC
  -> mint MYC to recipient
recipient can transfer MYC within whitelist
recipient calls redeem
  -> burn MYC
  -> emit Redeemed
```

### Tempo MPP Adapter

将 MPP support 作为 v2/v3 payment adapter，不能阻塞 v1。只有在 payment verifier、法律意见和 provider 商务许可明确后启用。

MPP direct request flow：

```text
1. Agent calls a paid endpoint without a MyKey API key or with insufficient balance.
2. Worker computes the price from service metering rules.
3. Worker returns HTTP 402 with a payment challenge.
4. Agent opens or reuses a Tempo payment channel.
5. Agent retries with signed payment voucher headers.
6. Worker verifies the voucher through the MPP/Tempo client or payment verifier.
7. Worker serves the API response.
8. Worker records a `mpp_charge` ledger entry and request log.
```

对于翻译和其他固定 unit API，MPP 可以在 preflight metering 后收费：

```text
text -> count source words/characters -> price -> 402 challenge -> paid retry -> translate
```

对于 LLM streaming，在 streaming payment primitive 足够稳定前，MPP 应保持在 balance mode 之后。安全的 beta 做法是：

```text
MPP payment authorizes maximum spend -> Worker reserves internal balance equivalent -> stream -> settle actual usage
```

MPP-specific modules：

```text
cloud-gateway/src/payments/mpp.ts
cloud-gateway/src/payments/payment-challenge.ts
cloud-gateway/src/metering/translation.ts
cloud-gateway/src/routes/translate.ts
```

重要设计规则：

- Balance mode 是重复用户的一等路径。
- MPP direct mode 是 accountless paid calls 的未来 agent-native 路径。
- 两者都写入同一套 ledger 和 usage logs。

### Chain Indexer

Advanced Beta 选项，仅在 MYC 合约进入实施后启用：

- 首选：Alchemy webhook、Goldsky 或同类 event webhook 到 Cloudflare Worker。
- Fallback：Cloudflare Cron Worker 通过 Base RPC provider 轮询 `eth_getLogs`。

Indexer 要求：

- 以 `(chain_id, tx_hash, log_index)` 保证幂等。
- 只接受配置的 contract address。
- 只处理 `Redeemed`。
- Credit 前确认 finality threshold，例如 Base 上 12 blocks。
- 写入 `compute_chain_events`。
- 向 Account Durable Object 发送 credit command。
- 将 ledger entry 镜像到 D1。

### MyKey Desktop 集成

MyKey Desktop 定位为运营控制台 + 钱包，不再承担 local gateway 或本地 token 中转运行面。当前本地 gateway 行为可以保持兼容，但不属于 v1 实施路径。

新增一个 `compute` view：

```text
src/components/ComputeGatewayManager.tsx
src/components/ComputeGatewayManager.css
src/types/compute.ts
```

新增 Tauri commands：

```text
get_compute_gateway_settings
set_compute_gateway_settings
list_compute_accounts
create_compute_account
update_compute_account
create_compute_api_key
revoke_compute_api_key
manual_credit_compute_account
list_compute_ledger_entries
list_compute_usage_logs
list_compute_topups
update_compute_price
list_compute_provider_tokens
upload_compute_provider_token
rotate_compute_provider_token
list_compute_routing_rules
upsert_compute_routing_rule
```

新增 Rust module：

```text
src-tauri/src/compute_cloud.rs
```

职责：

- 在本地存储 Cloudflare public gateway URL、admin endpoint、admin key 指纹和钱包配置。
- 调用 cloud admin API；生产环境 admin API 建议走 `admin.api.mykey.example`，并使用 mTLS、IP allowlist 或等价强保护。
- 选择并授权哪些上游 token/API 可以上传到 Cloudflare Vault。
- 钱包能力：签名 admin 操作、后续 USDC/MYC/MPP payment 管理。
- 渲染 balances 和 ledger。
- 避免在首次展示后保存 buyer raw API keys。

### 当前本地 Gateway 处理

local gateway 不再是本计划第一刀。以下事情不进入 v1：

- 不改造 `src-tauri/src/gateway.rs` 为公网 relay。
- 不为了 Cloudflare Gateway 修改 local Codex/Claude app token 行为。
- 不把 local request logs 作为 Cloudflare billing 的事实来源。

如果未来要保留本地 cost logging，可作为独立维护任务，不阻塞 Cloudflare-first 版本。

### 安全要求

- 永远不要记录 upstream API keys。
- 永远不要把 upstream API keys 返回给 buyers。
- 默认不保存 prompt/output bodies。
- 改为保存 request hashes 和 usage metadata。
- 在 logs 中 redacts Authorization、cookies 和 upstream headers。
- 在 Worker 前添加 WAF/rate limiting。
- 在 Durable Objects 中维护 per-account limits。
- 添加 global circuit breaker。
- 添加 per-provider circuit breaker。
- 添加 per-account model allowlist。
- 添加 buyer key revoke。
- 添加 account pause。
- 使用 Worker Secrets 存储 master key、server pepper 和 admin signing secrets。
- 上游 provider token 使用 envelope encryption；D1 不存明文。
- production 和 test environments 使用不同 keys。

### Observability

Metrics：

- Requests per minute。
- Success rate。
- Error rate。
- Blocked requests。
- Input/output tokens。
- Sell cost。
- Upstream cost。
- Gross margin。
- Balance by account。
- Reservations open/expired。
- v2 Chain top-up confirmations。

Logs：

- 默认只存储 metadata。
- 增加 operator-only 设置，用于调试时采样 request bodies。
- Sampling 默认必须关闭。

Alerts：

- Upstream error rate high。
- Provider quota near limit。
- Daily budget near limit。
- Negative balance detected。
- Reservation expiration spike。
- v2 Chain indexer delayed。
- D1 queue backlog high。

## 文件结构计划

Cloud gateway package：

```text
cloud-gateway/
  package.json
  wrangler.toml
  migrations/
    0001_compute_gateway.sql
  src/
    index.ts
    routes/openai.ts
    routes/admin.ts
    routes/dashboard.ts
    routing/router.ts
    routing/rules.ts
    vault/envelope.ts
    vault/provider-tokens.ts
    billing/account-do.ts
    billing/pricing.ts
    billing/reservations.ts
    auth/api-keys.ts
    quality/model-quality.ts
    providers/openai.ts
    queue/consumer.ts
    db/schema.ts
    errors.ts
  tests/
    health.test.ts
    api-key-auth.test.ts
    account-do-billing.test.ts
    pricing.test.ts
    routing.test.ts
    admin-api.test.ts
    dashboard-api.test.ts
    model-quality.test.ts
    provider-token-vault.test.ts
    relay-openai.test.ts
```

Buyer dashboard package：

```text
buyer-dashboard/
  package.json
  vite.config.ts
  src/App.tsx
  src/api.ts
  src/components/Overview.tsx
  src/components/ApiKeys.tsx
  src/components/Usage.tsx
  src/components/ModelQuality.tsx
  src/components/Credits.tsx
  src/components/Docs.tsx
  tests/dashboard.test.ts
```

Deferred v2/v3 package additions：

```text
cloud-gateway/src/routes/claude.ts
cloud-gateway/src/providers/anthropic.ts
cloud-gateway/src/routes/translate.ts
cloud-gateway/src/metering/translation.ts
cloud-gateway/src/payments/mpp.ts
cloud-gateway/src/payments/payment-challenge.ts
cloud-gateway/src/chain/indexer.ts
contracts/src/MyKeyComputeCredit.sol
```

Desktop additions：

```text
src/components/ComputeGatewayManager.tsx
src/components/ComputeGatewayManager.css
src/types/compute.ts
src-tauri/src/compute_cloud.rs
tests/computeGateway.test.ts
```

Docs：

```text
docs/compute-gateway.md
docs/compute-gateway-api.md
docs/compute-gateway-operator-runbook.md
```

## 实施任务

v1 每个 Task 应尽量控制在一次 PR 可 review 的范围内，目标是每个 PR 少于约 500 行核心 diff。MYC、合约、链上 indexer、MPP 和公开 resale 都不进入 v1。

### 当前实现进度（2026-05-19）

本轮已经把 Cloudflare-first v1 从静态方案推进到可测试的生产骨架：

- `cloud-gateway` 已包含 Worker project、D1 migration、API key HMAC 鉴权、dashboard session 鉴权、integer micro-USD pricing、account balance reserve/settle/refund、provider token envelope encryption、路由解析、provider health 更新和 request log/ledger 写入。
- Buyer 侧已有真实接口路径：`GET /v1/balance`、`GET /v1/usage`、`GET /v1/models`、`POST /v1/responses`。`/v1/responses` 当前支持 non-streaming OpenAI Responses relay：解密上游 token、转发请求、解析 usage、扣余额、记录 `provider_token_id` 和 `routing_rule_id`。
- Operator 侧已有可用 admin API：`GET/POST /admin/accounts`、`POST /admin/accounts/:id/api-keys`、`POST /admin/accounts/:id/manual-credit`、`POST /admin/provider-tokens`、`POST /admin/price-book`、`POST /admin/routing-rules`。完整 MyKey API key 只在创建时返回一次；provider token 明文和 ciphertext 都不会从 admin response 泄露。
- `buyer-dashboard` 默认从 `/dashboard/me` 等真实 API 加载数据；未登录或接口失败时展示错误态。本地 mock 只允许显式 `?preview=1`。
- 当前测试覆盖 `cloud-gateway` 19 个 Node tests、buyer dashboard 4 个 tests、桌面 compute linkage tests 和现有 gateway smoke test。

尚未完成、不能在发布说明里声称已具备的能力：

- 真正的 Account Durable Object 运行态、跨请求余额锁和 DO/D1 同步。
- `/v1/responses` streaming SSE 转发和 final usage event settle。
- API key revoke、dashboard API key create/revoke HTTP、invite accept HTTP、credit request approve/reject。
- Admin audit log、mTLS/IP allowlist、WAF/rate limit、Cloudflare production env/secrets 自动化配置。
- 多 provider adapter、`/v1/messages`、Translation API、MPP/USDC/MYC payment adapter。

### Task 1：Cloud Gateway Scaffold + D1 + API Key + Invite

**Files：**

- Create: `cloud-gateway/package.json`
- Create: `cloud-gateway/wrangler.toml`
- Create: `cloud-gateway/src/index.ts`
- Create: `cloud-gateway/src/errors.ts`
- Create: `cloud-gateway/migrations/0001_compute_gateway.sql`
- Create: `cloud-gateway/src/db/schema.ts`
- Create: `cloud-gateway/src/auth/api-keys.ts`
- Create: `cloud-gateway/tests/health.test.ts`
- Create: `cloud-gateway/tests/api-key-auth.test.ts`

- [ ] 添加带 `/health` 的 Worker project。
- [ ] 添加本地 test runner。
- [ ] 添加 `dev` 和 `production` 的 Wrangler environments。
- [ ] 创建 v1 必需 D1 tables：accounts、api_keys、account_invites、dashboard_sessions、credit_requests、price_book、routing_rules、model_allowlist、ledger、request_logs、provider_tokens、audit_logs。
- [ ] 添加 API key generation、HMAC hashing、prefix/last4 display 和 lookup。
- [ ] 添加 invite token hashing、过期和一次性 accept 语义。
- [ ] 为 valid、revoked、missing 和 malformed keys 添加 tests。
- [ ] 明确 `server_pepper` 轮换语义。
- [ ] 验证 `cloud-gateway` 内的 health 和 auth tests 通过。

### Task 2：Account Durable Object + Pricing + Manual Credit

**Files：**

- Create: `cloud-gateway/src/billing/account-do.ts`
- Create: `cloud-gateway/src/billing/reservations.ts`
- Create: `cloud-gateway/src/billing/pricing.ts`
- Create: `cloud-gateway/src/quality/model-quality.ts`
- Create: `cloud-gateway/src/routes/admin.ts`
- Create: `cloud-gateway/src/routes/dashboard.ts`
- Create: `cloud-gateway/tests/account-do-billing.test.ts`
- Create: `cloud-gateway/tests/pricing.test.ts`
- Create: `cloud-gateway/tests/admin-api.test.ts`
- Create: `cloud-gateway/tests/dashboard-api.test.ts`
- Create: `cloud-gateway/tests/model-quality.test.ts`

- [ ] 实现 per-account balance state，DO 是热路径事实来源。
- [ ] 实现 `credit`、`reserve`、`settle`、`refund` 和 `pause`。
- [ ] 为 duplicate settle/refund calls 添加 idempotency。
- [ ] 实现 integer micro-USD pricing、版本化 price book 和 reserve estimate。
- [ ] 添加 account CRUD、API key revocation、manual credit/debit、price book update 和 admin audit log。
- [ ] 添加 dashboard API：accept invite、session、me、balance、usage、ledger、model-quality、API key create/revoke、credit request。
- [ ] 管理端 API 默认走 `admin.api.mykey.example`，并预留 mTLS/IP allowlist。
- [ ] Dashboard API 只允许访问当前 account 数据，不允许 admin 操作。
- [ ] 为 reserve/settle/refund 和 insufficient balance 添加 tests。
- [ ] 为 rounding、minimum reserve 和 unknown model errors 添加 tests。
- [ ] 验证 billing、pricing、admin 和 dashboard API tests 通过。

### Task 3：Encrypted Token Vault + `/v1/responses` Relay

**Files：**

- Create: `cloud-gateway/src/vault/envelope.ts`
- Create: `cloud-gateway/src/vault/provider-tokens.ts`
- Create: `cloud-gateway/src/routing/router.ts`
- Create: `cloud-gateway/src/routing/rules.ts`
- Create: `cloud-gateway/src/routes/openai.ts`
- Create: `cloud-gateway/src/providers/openai.ts`
- Create: `cloud-gateway/tests/provider-token-vault.test.ts`
- Create: `cloud-gateway/tests/routing.test.ts`
- Create: `cloud-gateway/tests/relay-openai.test.ts`

- [ ] 实现 envelope encryption：D1 ciphertext + nonce + key_version，master key 在 Worker Secret 或外部 KMS。
- [ ] 添加 token pause、rotate、delete 和 emergency revoke。
- [ ] 明确 token 授权导入流程：只有明确选择公开共享的 token/API 才进入 Cloudflare Vault。
- [ ] 实现 `account_group + requested_model -> provider_token_id + actual_provider_model` 路由解析。
- [ ] 实现 provider token health 更新：success/failure、last_error、last_response_ms、exhausted_until。
- [ ] 添加 `/v1/models`。
- [ ] 添加 `/v1/responses`，第一版支持单 provider。
- [ ] upstream call 前解析 routing rule，并记录 `routing_rule_id` 和 `provider_token_id`。
- [ ] upstream call 前 reserve。
- [ ] 支持 streaming：转发 SSE chunks，解析 provider final usage event 后 settle。
- [ ] 如果 final usage 不可靠，fail closed 或使用 operator-only conservative reservation。
- [ ] 返回 OpenAI-compatible errors。
- [ ] 验证 vault 和 relay tests 通过。

### Task 4：Buyer Dashboard

**Files：**

- Create: `buyer-dashboard/package.json`
- Create: `buyer-dashboard/vite.config.ts`
- Create: `buyer-dashboard/src/App.tsx`
- Create: `buyer-dashboard/src/api.ts`
- Create: `buyer-dashboard/src/components/Overview.tsx`
- Create: `buyer-dashboard/src/components/ApiKeys.tsx`
- Create: `buyer-dashboard/src/components/Usage.tsx`
- Create: `buyer-dashboard/src/components/ModelQuality.tsx`
- Create: `buyer-dashboard/src/components/Credits.tsx`
- Create: `buyer-dashboard/src/components/Docs.tsx`
- Create: `buyer-dashboard/tests/dashboard.test.ts`

- [ ] 添加 invite accept / session login flow。
- [ ] 展示 balance、今日用量、最近请求和 account status。
- [ ] 添加 API key 创建、显示一次、撤销和复制 Base URL。
- [ ] 添加 usage、ledger 和 credit request 页面。
- [ ] 添加 Model Quality 页面：quality badge、latency、tokens/sec、最近错误、通道状态和 probe 入口。
- [ ] 添加 Docs 页面，包含 curl 和 OpenAI-compatible client 示例。
- [ ] 确保 Dashboard 不展示上游 token、上游成本和 admin controls。
- [ ] 验证 dashboard tests 通过。

### Task 5：MyKey Desktop Operator Console + Wallet

**Files：**

- Modify: `src/App.tsx`
- Create: `src/components/ComputeGatewayManager.tsx`
- Create: `src/components/ComputeGatewayManager.css`
- Create: `src/types/compute.ts`
- Create: `src-tauri/src/compute_cloud.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands.rs`
- Create: `tests/computeGateway.test.ts`

- [ ] 添加 `compute` navigation view。
- [ ] 将 cloud gateway settings、admin endpoint、admin key 指纹和 wallet 配置存入本地。
- [ ] 添加 admin API client commands。
- [ ] 添加 account、invite link、key、ledger、pricing、routing rule、provider token 授权导入、provider health 和 manual credit UI。
- [ ] 支持钱包签名 admin 操作的预留接口。
- [ ] 为 type mapping 和 account summary aggregation 添加 tests。
- [ ] 验证 `npm run test:linkage` 和 `npm run test:gateway` 通过。

### Deferred v2/v3：必须先过 gate

**Files：**

- Create: `docs/compute-gateway.md`
- Create: `docs/compute-gateway-api.md`
- Create: `docs/compute-gateway-operator-runbook.md`
- Modify: `README.md`
- Deferred: `cloud-gateway/src/routes/translate.ts`
- Deferred: `cloud-gateway/src/payments/mpp.ts`
- Deferred: `contracts/src/MyKeyComputeCredit.sol`
- Deferred: `cloud-gateway/src/chain/indexer.ts`

- [ ] Gate 1：确认 provider terms 或取得 OpenAI/Anthropic/其他 provider 的 aggregator/reseller/managed service 商务许可。
- [ ] Gate 2：取得法律意见，确认 USDC balance、MYC issuance、custody、money transmission 和 securities 风险边界。
- [ ] Gate 3：确认 MPP/Tempo payment verifier 的稳定接口和 replay protection 模型。
- [ ] Gate 4：确认 Cloudflare D1 当前版本对所需 partial index、事务和限制的支持。
- [ ] Gate 通过后再拆分 USDC top-up、Translation API、MPP adapter、MYC contract、chain event ingestion、Claude relay 和多 provider fallback。

## 推荐第一刀

按这个顺序构建：

1. Cloud Worker `/health`。
2. D1 schema + API key auth。
3. Manual credit + Account Durable Object balance。
4. Price book + reserve/settle。
5. Encrypted provider token vault。
6. Routing rule + provider token health。
7. `/v1/responses` single provider relay。
8. Streaming + final usage settle。
9. Buyer Dashboard invite、balance、usage、API keys、Model Quality。
10. MyKey Desktop operator read-only view。
11. MyKey Desktop account/key/routing/provider token management。
12. Docs/runbook + emergency pause drill。

这样可以先得到一个 Cloudflare-first、无法律链上复杂度、可真实验证 reserve/settle 和 streaming 的 private alpha。

## 验证命令

现有 repo：

```bash
npm run test:linkage
npm run test:gateway
```

Cloud gateway：

```bash
cd cloud-gateway
npm test
npx wrangler d1 migrations apply mykey-compute-dev --local
npx wrangler dev
```

Buyer dashboard：

```bash
cd buyer-dashboard
npm test
npm run build
```

Contracts：

```bash
cd contracts
forge test
```

Manual API smoke test：

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer sk-mykey_test_example"
```

## 风险与缓解

### 上游 Provider Terms

风险：公开 endpoint、收费、多账户和模型访问转售可能被 provider 解读为 reseller/aggregator 模式。即使不暴露 raw key，也可能需要单独商务协议或 provider 许可。

前置条件：

- 永不暴露 upstream keys。
- v1 只做运营者自己和受信用户的 private alpha，不做公开售卖。
- 公开收费或多账户扩展前，必须确认 provider terms 或取得对应 provider 的商务许可。
- docs 和 UI 明确提示 operator：上传 token 不代表有权公开转售模型访问。
- 如果 provider 条款不允许，该 provider 只能用于 operator self-use 或必须禁用 public sharing。

### MYC Securities Narrative

风险：用户将 MYC 理解为 investment token。MYC 即使在 UI 中隐藏，仍可能被视为 token issuance。

状态：

- MYC 不进入 v1。
- 合约开发不应在法律意见前启动。
- 默认 UX 隐藏 MYC。
- 固定 compute credit redemption。
- 不提供 price chart、yield、dividend、buyback 或 DEX prompt。
- 白名单参与。

### Money Transmission 和 Custody

风险：USDC top-up 和 credit balances 可能触发监管义务。

状态：

- USDC top-up 不进入 v1。
- 保持 private beta 小规模。
- 公开发布或引入 USDC/MYC 前咨询律师。
- 添加 per-user limits。
- 在扩大开放前添加 sanctions/abuse screening。

### Streaming Usage Ambiguity

风险：Streaming providers 可能不会在 final event 中返回精确 usage。

缓解：

- v1 就支持 streaming，但只启用能稳定返回 final usage 的 provider/model。
- 为 streaming 添加更大的 reservation。
- 单独标记 estimated usage。
- 如果 final usage 不可靠，fail closed 或切换到 operator-only conservative reservation。
- 在可用时通过 provider usage APIs 对账。

### Balance Consistency

风险：并发请求导致账户余额超花。

缓解：

- 使用 per-account Durable Object。
- upstream request 前必须 reserve。
- 使用 idempotent settle/refund。
- 过期 stale reservations。

### Cloudflare Runtime Dependence

风险：方向变更为 Cloudflare-first 后，请求热路径依赖 Cloudflare、Worker Secrets、D1、Durable Objects 和公网网络。

缓解：

- 明确 Compute Gateway 是 cloud-run product，不再承诺 local-first。
- MyKey Desktop 只做运营控制台 + 钱包。
- 为 Worker、D1、DO、Queues 添加 health checks、backup/export 和 emergency pause。
- 保留本地 token 备份，但本地备份不参与公网请求热路径。

## 自查

- 产品范围第一版覆盖 Cloudflare Gateway、encrypted token vault、manual credit、API keys、usage billing 和 operator controls。
- MYC、USDC top-up、MPP 和 chain indexer 已明确推迟到 v2/v3 gate。
- 技术范围将 MyKey Desktop 定义为运营控制台 + 钱包，公网运行面全部在 Cloudflare。
- 已记录当前代码约束。
- 不需要公开共享 raw API key。
- 第一版可以通过 manual credit 在没有 chain integration 的情况下测试。
- Chain integration 推迟到 Advanced Beta，并保留 idempotency 和 finality rules。
- 实施任务包含具体文件路径和验证命令。

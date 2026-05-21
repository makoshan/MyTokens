# v1 收尾计划：credit requests + Account DO + 安全运维

> **续：** [2026-05-19-compute-credit-gateway.md](./2026-05-19-compute-credit-gateway.md)。此计划只覆盖 v1 plan 里「尚未完成」的剩余三块，且推迟 v2/v3 gate。

**目标：** 把 private alpha 从「能跑」推到「敢长开」。Credit request 闭环让 buyer 自助补 credit；Account DO 消除并发超花；audit log + IP allowlist + rate limit + 自动化部署让生产能 7×24 暴露。

**约束：**

- ~~不引入 v2/v3 项（MPP、USDC、MYC、链上 indexer、translation 等）。~~ **⚠️ 此约束已于 2026-05-20 晚被推翻——MYC 红包 / gasless redeem / burn-to-credit 已实现并成为产品核心。详见文末「计划外 pivot：MYC 红包共享」。**
- 每块尽量一次 PR（< 500 行核心 diff）。
- 不破现有 34 个测试。

---

## 当前进度（2026-05-20）

已完成（commits f5a5701 → 4de16dd）：

- v1 cloud gateway alpha：Worker + D1 + 加密 vault + reserve/settle/refund + manual credit
- Streaming SSE relay + fail-closed settle
- Dashboard self-service：invite accept / API key create+revoke / admin revoke any
- Adapter framework：openAIAdapter（`/v1/responses`）+ anthropicAdapter（`/v1/messages`）
- 部署工具链：wrangler scripts、gen-secrets、bootstrap、DEPLOY.md

剩余三块按依赖排序：

1. **Block A — Credit Requests**（1 PR，1 天）：完结 buyer 自助闭环。
2. **Block C1+C2+C4 — Audit log + IP allowlist + CI 部署**（3 个小 PR，2 天）：安全 + 运维基线。
3. **Block B — Account Durable Object**（1–2 PR，3–5 天）：消除超花。最高风险，放在测试设施齐全后再动。
4. **Block C3 — Rate limit**（1 PR，1–2 天）：依赖 Block B 的 DO 基础设施。

---

## Block A — Credit Request 审批闭环

**Files：**

- Modify: `cloud-gateway/src/routes/dashboard.ts`（已有 `createCreditRequest` helper，扩字段）
- Modify: `cloud-gateway/src/db/store.ts`
- Modify: `cloud-gateway/src/index.ts`
- Create: `cloud-gateway/tests/credit-requests.test.ts`

**Schema 现状：** `compute_credit_requests` 表已存在（id / account_id / requested_micro_usd / message / status / created_at / resolved_at / resolved_by）。

**Store 接口：**

- [ ] `createCreditRequest({accountId, requestedMicroUsd, message?, now}) → record`
- [ ] `listCreditRequests({accountId?, statusFilter?, limit?})`：account 维度过滤（dashboard）或 pending 全表扫（admin）。
- [ ] `getCreditRequest(id)`
- [ ] `resolveCreditRequest({id, decision: 'approve'|'reject', resolvedBy, reason?, now})`：approve 时**通过幂等键写 ledger + manualCredit**，再 UPDATE status='approved'；reject 仅 UPDATE。

**HTTP 路由：**

- [ ] `POST /dashboard/credit-requests`（session）：body `{requested_micro_usd, message?}`。返回 record。
- [ ] `GET /dashboard/credit-requests`（session）：返回当前账户的 list。
- [ ] `GET /admin/credit-requests?status=pending`（admin）：返回待处理 list。
- [ ] `POST /admin/credit-requests/:id/approve`（admin）：调 `resolveCreditRequest`，幂等。同时写 audit log（依赖 C1，先留 TODO）。
- [ ] `POST /admin/credit-requests/:id/reject`（admin）：可选 body `{reason?}`。

**幂等关键点：**

approve 路径必须保证「同一 credit_request 不会被 credit 两次」。方案：

```
ledger.id = `cr_${credit_request_id}`   # 主键约束保证唯一
SQL:
  BEGIN;
  INSERT INTO compute_ledger_entries (id='cr_<reqId>', type='credit', amount, balance_after, ...)
    -- 如果已存在则 ON CONFLICT DO NOTHING；rows_affected=0 表示之前已经 credit 过
  UPDATE compute_credit_requests SET status='approved', resolved_at, resolved_by WHERE id=? AND status='pending'
  COMMIT;
```

D1 支持 `db.batch([stmt1, stmt2])` 原子执行，用它。

**边界：**

- [ ] approve 一个已 `approved` 或 `rejected` 的请求：返回当前状态的 409。
- [ ] reject 一个已 `approved` 的请求：返回 409。
- [ ] dashboard 查另一个账户的请求 ID：返回 404（不泄露存在性）。
- [ ] requestedMicroUsd ≤ 0 或非整数：400。

**Tests：**

- [ ] dashboard 提交 → admin 列出 → admin approve → balance 增加 → 重 approve 返回 409。
- [ ] reject 流程 → 再 approve 返回 409。
- [ ] 跨账户 dashboard list 隔离。
- [ ] 同一 request 并发 approve 只 credit 一次（用 sequential 但断言 ledger 只有一条 `cr_<id>`）。

**验收：** `npm test` 现有 34 + 新增 ~5 全过。

---

## Block C1 — Admin Audit Log

**Files：**

- Modify: `cloud-gateway/src/db/store.ts`
- Modify: `cloud-gateway/src/index.ts`
- Create: `cloud-gateway/tests/admin-audit.test.ts`

**Schema 现状：** `compute_admin_audit_log` 表已存在（v1 plan line 201）。

**Store 接口：**

- [ ] `recordAdminAudit({id, action, actor, targetType, targetId, payloadHash, statusCode, createdAt})`
- [ ] `listAdminAudit({limit?, since?})`

**Wrapper：**

把现有 `requireAdmin(request, adminToken)` 改写为返回一个 `AuditContext`，每条 admin 路由结尾在 try/finally 里调用 `ctx.commit(statusCode)`。或者更简单：在每个 admin 路由里一次性调用：

```ts
await store.recordAdminAudit({
  id: `audit_${crypto.randomUUID()}`,
  action: 'admin.account.manual_credit',
  actor: 'admin',  // 后续接 mTLS cert subject
  targetType: 'account',
  targetId: accountId,
  payloadHash: sha256(JSON.stringify(body)),
  statusCode: 200,
  createdAt: now,
})
```

`payloadHash` 不存明文 body — 避免 leak provider token 明文。

**Tests：**

- [ ] 每条 admin route 命中后 audit 表 +1。
- [ ] payloadHash 是 sha256 hex，长度 64。
- [ ] dashboard route 不写 audit（隔离 actor）。

---

## Block C2 — Admin IP Allowlist

**Files：**

- Modify: `cloud-gateway/src/index.ts`（在 `requireAdmin` 之前）
- Modify: `cloud-gateway/wrangler.toml`（加 `ADMIN_IP_ALLOWLIST` 非 secret 变量）
- Modify: `cloud-gateway/DEPLOY.md`

**实现：**

```ts
function requireAdminIp(request: Request, env: GatewayEnv) {
  const allowlist = env.ADMIN_IP_ALLOWLIST?.split(',').map(s => s.trim()).filter(Boolean) ?? []
  if (allowlist.length === 0) return  // unset = open (dev)
  const ip = request.headers.get('cf-connecting-ip')
  if (!ip || !matchesAnyCidr(ip, allowlist)) {
    throw new GatewayError('admin_ip_denied', 403)
  }
}
```

**边界：**

- 空 allowlist 等价于不启用（dev 友好），但 DEPLOY.md 警告生产必须配置。
- 写一个简单的 CIDR match：`192.168.1.0/24` 或单 IP `1.2.3.4`。IPv6 v1 不支持（worker 一般也用 IPv4 forward）。
- 现有 `requireAdmin` 顺序：先 IP 再 token，IP 失败用 403 不泄露 token 配置情况。

**Tests：**

- [ ] allowlist 空：admin 路由放行。
- [ ] allowlist 设置且 `cf-connecting-ip` 不匹配：403。
- [ ] allowlist 匹配 + 错 token：401。
- [ ] CIDR `10.0.0.0/24` 匹配 `10.0.0.5` 不匹配 `10.0.1.5`。

**进阶（v2 候选，不进 C2）：** 走 Cloudflare Access mTLS。Worker 读 `request.cf.tlsClientAuth?.certVerified === 'SUCCESS'`，证书 subject CN 作为 actor 写入 audit。需要在 CF dashboard 配 Access policy + mTLS CA。

---

## Block C4 — 生产 secrets 自动化

**Files：**

- Create: `.github/workflows/deploy-gateway.yml`
- Modify: `cloud-gateway/DEPLOY.md`

**目标：** push tag `gateway-v*` → CI 跑测试 → 用 OIDC token 调 `cloudflare/wrangler-action` 部署。

**关键点：**

- 用 **Cloudflare OIDC**（短期 token）而不是长期 API key。比较安全。
- Secrets 不在 GH Actions secrets 里明文存 — 通过 `wrangler secret put` 在 deploy 前推送（值来自 GH secret，但只在内存里短暂出现）。
- 工作流：

```yaml
on:
  push:
    tags: ['gateway-v*']
jobs:
  deploy:
    permissions:
      id-token: write  # OIDC
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test
        working-directory: cloud-gateway
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          workingDirectory: cloud-gateway
          command: deploy
```

**审慎选项：**

- Manual gate：tag 推送后用 GH Actions `environment: production` 强制人工 approve。
- Slack/Notion webhook 通知部署事件（v2 候选）。

**DEPLOY.md 更新：**

- 增加「CI 部署」一节：tag 发布流程、回滚流程（`wrangler rollback` 仍人工）。

---

## Block B — Account Durable Object

**最大、最危险。** 当前 `AccountBalance` 每请求从 D1 快照重建，并发请求各自 reserve 互不感知，能超花。DO 是 v1 唯一的修复路径。

### 设计

**一个 account = 一个 DO 实例。** 通过 `env.ACCOUNT_DO.idFromName(accountId)` 获取稳定 ID，Cloudflare 保证同 ID 全球单实例、单线程。

```
┌──────────────┐  RPC   ┌─────────────────────────┐
│ handleRelay  │ ─────► │ AccountDurableObject     │
│  Route       │        │  - in-memory balance     │
└──────┬───────┘        │  - storage.put on mutate │
       │                └──────────┬──────────────┘
       │                           │ async
       │                           ▼
       │                    ┌──────────────┐
       └─── persist log ───►│      D1      │
                            └──────────────┘
```

**DO 职责：**

- 单一事实来源（balance + open reservations）。
- 持久化到 `state.storage`（Worker 重启后自动 hibernate/rehydrate）。
- 首次激活从 D1 拉初始 balance（bootstrap）。

**D1 职责：**

- request log + ledger 历史归档（分析、对账、买家用量图）。
- 跨账户列表 / admin 视图。
- 不再是 hot path 的写入瓶颈。

**RPC 接口（DO 类的方法）：**

- `reserve({reservationId, requestId, estimatedMicroUsd, provider, model, now})`
- `settle({reservationId, actualMicroUsd, idempotencyKey, now})`
- `refund({reservationId, idempotencyKey, now})`
- `credit({amountMicroUsd, idempotencyKey, now})` ← 给 Block A 的 approve 用
- `snapshot()` ← 给 `/v1/balance`、`/dashboard/balance` 用
- `pause()` / `resume()` ← 给 admin 用

### Files

- Modify: `cloud-gateway/src/billing/account-do.ts`（核心改造）
- Modify: `cloud-gateway/src/index.ts`（从 new AccountBalance 改为 `env.ACCOUNT_DO.get(id)`）
- Modify: `cloud-gateway/src/routes/relay.ts`（接受 DO stub 而非 AccountBalance；接口抽象）
- Modify: `cloud-gateway/wrangler.toml`（DO migration 已在；确认 binding）
- Create: `cloud-gateway/src/billing/account-do-stub.ts`（测试用的本地 stub，行为等价于真 DO）
- Modify: 现有所有传 `AccountBalance` 的测试。
- Add: `@cloudflare/vitest-pool-workers` + vitest 配置（或 unstable_dev）。

### 任务

- [ ] `AccountDurableObject extends DurableObject<Env>`，用 `state.blockConcurrencyWhile` 确保 hydration race-safe。
- [ ] 实现 6 个 RPC 方法。reserve/settle/refund 复用现有 `AccountBalance` 逻辑（移成内部 helper）。
- [ ] storage 写入策略：每次 settle/refund 后 `state.storage.put('state', snapshot)`。reserve 不一定要持久化（可丢失，下次会重新计算），但保守起见也写。
- [ ] 抽象 `AccountActor` 接口（`reserve/settle/refund/credit/snapshot`），让 relay 不依赖 DO 类型。生产是 DO stub，测试是 InMemoryAccountActor（包 AccountBalance）。
- [ ] `handleRelayRoute` 改造：拿 `env.ACCOUNT_DO.idFromName(accountId).get()`，调用 RPC。`ctx.waitUntil(streamFinalize)` 里也必须用 stub（不能复用本地 AccountBalance）。
- [ ] 处理「DO 不存在 D1 账户」情况：DO 首次激活如果 storage 空，且 D1 也没该 account → 404 而不是创建虚账户。
- [ ] D1 ledger / request log 写入仍由 worker 完成（DO 不直接 access D1，保持职责分离；DO 操作完后 worker 拿返回值再落 D1）。
- [ ] 测试设施：`@cloudflare/vitest-pool-workers` + worker-test 模式跑 DO；或保留 node:test 但用 InMemoryAccountActor 做大部分逻辑测试，再加 1 个 vitest pool 跑「并发 reserve 无超花」证明。

### 边界 / 风险

- **冷启动延迟：** DO 首次激活 ~50-100ms。对小 account 一次性。
- **跨 region：** DO 可能远离 Worker，RPC 跨区可达 50-100ms。Cloudflare 提供 `LocationHint` 控制。v1 不优化，留 TODO。
- **DO storage 容量：** 单 DO 上限 ~128MB。我们存 balance + open reservations + 少量元数据，远低于。
- **测试复杂度：** node:test 跑不动真 DO。要 vitest-pool-workers。
- **回退路径：** 部署 DO 版本后如果热路径出 bug，难以快速回滚到「无 DO」版本（因 wrangler.toml DO migration 不能 rollback class）。先在 dev account 跑 1 周再上 prod。
- **Reservation 过期：** 现在 AccountBalance 不过期 reservations，DO 应该用 `state.storage.setAlarm` 在 5 分钟后 auto-refund 未 settle 的 reservation。

### Tests

- [ ] 单元（InMemoryAccountActor）：reserve/settle/refund/credit 行为不变（沿用现有测试）。
- [ ] vitest-pool-workers 集成：起两个并发 reserve，断言只有一个成功（另一个 402）。
- [ ] vitest-pool-workers：DO restart 后 hydration 恢复 balance。
- [ ] alarm-driven reservation 过期。
- [ ] /v1/balance 通过 DO 读取，不直接 D1（避免 race）。

---

## Block C3 — Rate Limit（DO 完成后做）

**Files：**

- Create: `cloud-gateway/src/billing/rate-limit-do.ts` 或扩 `AccountDurableObject`
- Modify: `cloud-gateway/src/index.ts`

**两层：**

1. **Per-account RPM/concurrency：** 在 AccountDurableObject 里加 sliding window counter（token bucket 或 GCRA），每次 reserve 前 check。超限抛 429。
2. **Cloudflare Rate Limiting Rules：** dashboard 配，按 IP 限。无代码工作，DEPLOY.md 增章节。

**Tests：**

- [ ] 单 account 1 秒内 N 个请求，第 N+1 个 429。
- [ ] 不同 account 的限额互不影响。

---

## 风险汇总

| 风险 | 缓解 | 影响块 |
|------|------|--------|
| Approve 双 credit | ledger.id = `cr_<reqId>` 主键约束 + D1 batch | A |
| Audit log 写失败导致 admin route 失败 | audit log 用 best-effort（catch 不 propagate），但记 worker log | C1 |
| IP allowlist 错配把自己锁外 | DEPLOY.md 强调先在 staging 测；保留紧急通道（如 wrangler tail 看 log，手动改 var） | C2 |
| CI OIDC 配错导致部署半成品 | environment 加 manual approval；deploy 后跑 health check | C4 |
| DO 改造导致整个 relay 退化 | dev 环境 1 周；增 vitest-pool-workers 测试；准备 wrangler rollback runbook | B |
| Rate limit 过严误伤正常调用 | 单 account 默认非常宽（如 10 RPS）；dashboard 显示当前用量；DEPLOY.md 给调整 SQL | C3 |

---

## 推荐顺序

1. **Block A**（1 天）：完结 buyer 自助闭环，是面向用户最小可见进度。
2. **Block C1**（0.5 天）：audit log，配合 Block A 的 approve action 一起测。
3. **Block C2**（0.5 天）：IP allowlist，独立小改。
4. **Block C4**（0.5–1 天）：CI 部署，让后面 Block B 上线靠 CI。
5. **Block B**（3–5 天）：最大改造，放最后。
6. **Block C3**（1–2 天）：rate limit 在 DO 基础上做最便宜。

总计 ~7–10 天，每块都可独立提一个 PR。

---

## 学习清单

按推进顺序匹配的资料，按优先级排：

### Block B（DO）—— 收益最高

- **Cloudflare Durable Objects 官方文档：** https://developers.cloudflare.com/durable-objects/
  - 重点读 `state.blockConcurrencyWhile`、`state.storage.setAlarm`、RPC 方法定义。
- **Counter 示例：** https://github.com/cloudflare/templates/tree/main/durable-objects-counter-template
  - 几乎就是我们要写的 reserve/settle 形态。
- **Hibernation API：** https://developers.cloudflare.com/durable-objects/best-practices/websockets/#hibernation-api
  - 即便我们不用 WebSocket，hibernation 思想（storage 即冷启动恢复源）一致。
- **`@cloudflare/vitest-pool-workers`：** https://developers.cloudflare.com/workers/testing/vitest-integration/
  - DO 集成测试唯一靠谱方案。
- **「Building Stripe-like idempotency」：** https://stripe.com/blog/online-migrations
  - reserve/settle 幂等 + ledger 设计的工程参考。

### Block A（credit requests）

- **D1 batch transactions：** https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
  - approve 路径的原子性靠它。
- **Stripe 「Idempotency Keys」博客：** https://stripe.com/docs/api/idempotent_requests
  - 我们的 `cr_<id>` ledger key 是同样思路。

### Block C1（audit log）

- **OWASP ASVS V7（Logging & Monitoring）：** https://github.com/OWASP/ASVS
  - 第 7.1–7.4 节给出 admin 操作必须记录的字段清单。
- **Anthropic 工程博客「Audit logs for AI APIs」**（如有）：搜索 Anthropic / OpenAI 的 audit log 设计。

### Block C2（IP allowlist + mTLS）

- **Cloudflare Access mTLS：** https://developers.cloudflare.com/cloudflare-one/identity/devices/mutual-tls-authentication/
  - mTLS 是 v2 升级路径；v1 IP allowlist 是过渡。
- **Workers `cf` 对象：** https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties
  - 看 `cf.tlsClientAuth` 字段，为 mTLS 准备。

### Block C3（rate limit）

- **GCRA / token bucket 解析：** https://brandur.org/rate-limiting
  - Brandur 的文章，把算法讲清楚的最佳来源之一。
- **Cloudflare 自己的 Rate Limiting API：** https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
  - Workers Paid 内置 rate limiter，可能比自己写 DO 更划算。先评估再决定。

### Block C4（CI 部署）

- **Cloudflare OIDC + GitHub Actions：** https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
  - 官方 CI 模式。
- **`cloudflare/wrangler-action`：** https://github.com/cloudflare/wrangler-action
  - 比手写 `wrangler deploy` 步骤更稳。

### 跨块通用

- **One-API / Claude-Relay 源码阅读**（v1 plan line 469-570 已分析）：
  - 看他们怎么处理 channel 健康度、provider 错误归一化、weight 路由。
  - 我们用 adapter pattern 比他们干净，但可以借鉴 fallback / circuit breaker。
- **W3C EventSource spec：** https://html.spec.whatwg.org/multipage/server-sent-events.html
  - 我们的 SSE 解析手写，对照规范确认边界（comment 行、retry 字段）。
- **Cloudflare Workers 限制清单：** https://developers.cloudflare.com/workers/platform/limits/
  - 知道边界：DO storage 128MB、Worker 30s wall time、CPU 50ms（免费）/30s（付费）、subrequest 50 个。

---

## 自查

- [ ] Block A、B、C 每块都能独立提 PR 并通过现有测试。
- [ ] Block A 的 approve 幂等设计有 ledger 主键证明。
- [ ] Block B 的 DO 测试通过 vitest-pool-workers 实测并发场景。
- [ ] C1 audit log 不存原 body（只存 hash），不泄露 admin token 或 provider key。
- [ ] C2 allowlist 默认非启用（dev 友好），生产必须设置（DEPLOY.md 显眼提示）。
- [ ] C4 CI 用 OIDC 而非长期 API token。
- [ ] 部署 Block B 前先在 dev account 跑 7 天，监控 DO 冷启动延迟、storage 大小。
- [ ] Rate limit 默认阈值宽松（避免误伤），且有 dashboard 可观测。

---

## 计划外 pivot：MYC 红包共享（2026-05-20 晚）

> **状态：已实现并部署在 commit `5121af2`。** 本节记录一次**计划外的方向转变**——代码冲进了 [2026-05-19 计划](./2026-05-19-compute-credit-gateway.md) 明确 gate 在「法律意见之后」的 MYC/链上支付 territory。决定（2026-05-20）：**这是有意 pivot，红包 / MYC 支付是现在的产品核心，计划追代码**。本节的作用是让规划与代码一致，并**诚实记录 4 个 legal gate 仍未通过**——不假装已过。

### 偏离的本质

两份原计划的核心论点都是「先验证 Cloudflare 基建，把 MYC 叙事 defer 到 gate 通过之后」。代码做了相反的事：MYC 现在是支付与获客的中心。

### 已实现（计划里属于 deferred / Advanced Beta / 非目标的部分）

| 能力 | 文件 / 路由 | 原计划定位 |
|------|-----------|-----------|
| MYC burn-to-credit 充值 | `migrations/0002_onchain_topups.sql`、`src/routes/topup.ts`、`/dashboard/topup`、`/admin/topups` | Advanced Beta，Gate 2 之后 |
| 红包（运营预建 + 朋友领取） | `migrations/0003_redpackets.sql`、`/dashboard/claim`、`/admin/redpackets`、`buyer-dashboard/.../RedpacketClaim.tsx` | 「Invite credits / airdrops」= Advanced Beta |
| Relayer pool + gasless redeem | `src/routes/relayer.ts`（`relayerTransfer` / `relayerBurnWithSig`）、`/dashboard/redeem-gasless`、`RELAYER_PRIVATE_KEY` | **原计划无此项** |
| MYC TIP-20 合约 | `contracts/src/MyKeyComputeCredit.sol` | Deferred，「前提是法律意见允许」 |
| 买家浏览器 passkey 钱包 | `buyer-dashboard/src/wallet.ts`（WebAuthn PRF 派生密钥） | 原计划买家 dashboard **无钱包** |

链上 indexer（计划的 `src/chain/indexer.ts`）**未建**——改用轻量的 `verifyAndCreditBurn`（请求时读链验证单笔 burn），是务实替换，不是遗漏。MPP adapter、Translation API 仍未做（仍 deferred）。

### Legal gate 状态（诚实标注，无一通过）

原计划 [Gate 1–4](./2026-05-19-compute-credit-gateway.md) 锁住的正是现在已上线的能力。截至 2026-05-20：

| Gate | 内容 | 状态 |
|------|------|------|
| Gate 1 | Provider（百炼/Kimi/OpenAI/Anthropic）的 aggregator/reseller/managed-service 商务授权 | ❌ 未取得 |
| Gate 2 | 法律意见：MYC 发行 / custody / money transmission / 证券风险边界 | ❌ 未取得 |
| Gate 3 | MPP/Tempo payment verifier 稳定接口 + replay protection | ⚠️ 未走 MPP；burn-to-credit 自带 tx-hash 去重，但未做正式 replay 模型审查 |
| Gate 4 | Cloudflare D1 对所需 partial index / 事务 / 限制的支持 | ✅ 实践中已验证（D1 + DO 已上线）|

→ **公开拉新人前，Gate 1 + Gate 2 是真实法律风险**（reselling 百炼/Kimi 订阅算力可能违反 provider ToS，账号被封则所有朋友断供；自发 token 计费触及证券/汇兑监管）。pivot ≠ gate 已过；pivot 意味着「明知 gate 未过，alpha 阶段在受信朋友小圈子内先跑」。

### 产品心智模型的变化

原计划：「普通用户不需要理解 mint / burn / redeem / MYC」，只看 `API key / 余额 / 用量 / 账单`。

现在（红包 UX，**有意**）：直接给朋友看 `20 MYC ≈ $20`、token 估算、「兑换」CTA。crypto 层从「藏起来」变成「拆礼品卡的仪式感卖点」。这是 pivot 的一部分，不是 bug——但要清楚它和原心智模型相反。

### 链：Sepolia 测试网（alpha 决定 2026-05-20）

`wrangler.toml` 配置 `TEMPO_CHAIN_ID=11155111`（Sepolia），与 project memory 里的「Tempo 主网」目标暂时不一致。**alpha 阶段有意留在 Sepolia**：红包领取 / gasless redeem 走测试网 MYC，不消耗真实价值。主网切换是后续动作，需同时确认 `MYC_TOKEN_ADDRESS` 在目标链上的部署与 relayer pool 充值。

### 下一步工作

1. **测试（已批准，最高优先级）**：红包后端 + 组件单测。
   - `/dashboard/claim` 幂等（领取 → claimed；再领 → 409）+ 校验（非法地址 400、未知口令 404）。
   - `/accept?token=X&redpacket=Y` → 302 必须带 `?redpacket=Y` 的**回归测试**（防止透传 bug 重现）。
   - `RedpacketClaim` 组件状态机：`sealed → opening → revealed → redeeming → done` + `humanError` 映射。
   - **前置改动**：`createGatewayApp` 需加一个 relayer 注入缝（与现有 `fetchImpl` 同款），让 claim/redeem 单测不打真 RPC。
2. **部署 `/accept` 修复**：透传逻辑（`index.ts:444`）已在代码里，但线上 worker 未部署——合一邀请链接的红包覆盖层目前弹不出。需 `cd cloud-gateway && npm run build && wrangler deploy`（对外动作，需确认）。
3. **运营文档**：原计划的 `docs/compute-gateway-operator-runbook.md` 等仍为零；红包/relayer 的运维（pool 充值、stale 退款、口令生成）需要 runbook。

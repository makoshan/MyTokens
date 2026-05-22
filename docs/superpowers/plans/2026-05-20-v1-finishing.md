# v1 收尾计划：基建收口 + MYC 红包主流程

> **续：** [2026-05-19-compute-credit-gateway.md](./2026-05-19-compute-credit-gateway.md)。本文件最初只覆盖 v1 plan 里「尚未完成」的基建收口；2026-05-21 对照代码后，追加记录 MYC 红包推荐主流程与下一轮改造方向。

**目标：** 把 private alpha 从「能跑」推到「敢长开」。Credit request 闭环让 buyer 自助补 credit；Account DO 消除并发超花；audit log + IP allowlist + rate limit + 自动化部署让生产能 7×24 暴露。

**约束：**

- ~~不引入 v2/v3 项（MPP、USDC、MYC、链上 indexer、translation 等）。~~ **⚠️ 此约束已于 2026-05-20 晚被推翻——MYC 红包 / gasless redeem / burn-to-credit 已实现并成为产品核心。详见文末「计划外 pivot：MYC 红包共享」。**
- 每块尽量一次 PR（< 500 行核心 diff）。
- 不破现有测试；“34 个测试”是 2026-05-20 计划时的历史基线，当前测试集已扩大。

---

## 当前进度（2026-05-21 对照代码后）

> **Product spec note：** AGENTS.md 指向的 `/Users/thursday/go/play/mykey/Docs_code/Mykey 产品文档.md` 当前工作区不存在；本次先按现有代码和本计划文档对齐。恢复产品 spec 后，要重新核对术语、legal gate 和默认主流程。

已完成 / 当前代码里已看到：

- v1 cloud gateway alpha：Worker + D1 + 加密 vault + reserve/settle/refund + manual credit。
- Streaming SSE relay + fail-closed settle；`/v1/responses` 和 `/v1/messages` 已接 provider adapter。
- Dashboard self-service：invite accept、API key create/revoke、admin revoke any。
- **Block A Credit Requests：** `/dashboard/credit-requests`、`/admin/credit-requests` approve/reject、幂等 resolve 和测试文件已存在。
- **Block C1 Audit Log：** admin action audit、payload hash / metadata、`/admin/audit-log` 和测试文件已存在。
- **Block C2 IP Allowlist：** `src/admin-ip.ts`、`ADMIN_IP_ALLOWLIST` 路径和测试文件已存在。
- **Block B Account DO：** `AccountActor` 抽象、`DurableObjectAccountActor`、`AccountDurableObject`、DO alarm 自动释放 reservation 和 workerd 测试已存在。
- **Block C3 Rate Limit：** account RPM limit 已在 `AccountBalance.reserve()` 热路径上生效，并有 rate-limit 测试。
- **MYC 红包 pivot：** `/accept?token=...&redpacket=...`、`/dashboard/claim`、`/dashboard/redeem-gasless`、passkey 钱包、红包测试和前端红包状态机已进入代码。

所以这份文档下面的 Block A/B/C/C3 现在应视为**历史实施计划 + 设计记录**，不再是最短路径。2026-05-21 起，v1 收口的真正瓶颈变成“推荐主流程”是否顺滑：

1. 运营者在 MyKey 原生 App 的 `算力网关` 里共享上游模型。
2. 运营者生成带红包的邀请链接。
3. 朋友打开链接，passkey 建钱包，领 MYC，免 gas 兑换 AI 额度。
4. 朋友优先直接在网页 `AI 对话` 测试模型。
5. 朋友需要接入自己的客户端时，再创建并复制 MyKey API Key。

当前代码已完成 1-3 和 5；**第 4 步 `AI 对话` 还没有落地**，这是下一轮改造主线。

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

### 2026-05-21 MVP UX 决策

红包 / MYC 只面向**受信朋友 alpha**，不是公开转售、投资型 token 或收益承诺。Gate 1（provider 商务授权）和 Gate 2（法律意见）未通过前，所有文案都避免「公开卖模型」「MYC 升值」「无限制转售 API」。

核心承诺：

> 运营者共享授权的上游 AI Key，给朋友发一个算力红包；朋友兑换后可以立刻在网页里测试模型，也可以复制 MyKey API Key 接入自己的 OpenAI-compatible 客户端。

主流程：

1. 运营者进入 MyKey 原生 App 的 `算力网关`。
2. 在「共享 AI Token」里选择百炼 / Kimi / OpenAI / Anthropic，填写模型 ID 和上游 API Token；系统自动创建 channel、price、routing。
3. 在「邀请朋友用模型」里填写朋友名称、模型、红包 MYC 数量，生成合一链接：`/accept?token=...&redpacket=...`。
4. 朋友打开链接，使用 passkey 创建钱包，领取 MYC，并兑换成 AI 额度。
5. 兑换成功后默认进入网页 `AI 对话` 试用；需要接入自己客户端时，再复制 Base URL 和 `sk-mykey_*`。

MVP 只保留：

- 运营者端：`算力网关`、`密钥库`、`全局设置`。`算力网关` 内只做连接网关、添加上游 AI Key、生成邀请、查看红包/兑换状态。
- 朋友端：`领取 / 兑换`、`AI 对话`、`MyKey API Key`、`余额 / 接入说明`。
- 高级入口：`应用`、`MCP`、`Skills`、`提示词` 合并为一个 `AI 功能`，默认隐藏；UI 合并即可，底层数据结构和权限仍分开。

暂不进入主流程：

- `项目`、`应用绑定`、`提示词库`、`历史记录`。
- 完整 `Crypto` 钱包、NFT、swap、portfolio；朋友端只保留 passkey 钱包领取/兑换 MYC。
- 大型 Usage & Cost 总览、模型质量排行、全量审计表。
- 完整 ChatGPT 形态：网页 `AI 对话` 只做最小在线测试，不做 MCP 调用、文件上传、联网搜索、长历史管理。

命名约束：

- `Admin Token`：运营者管理网关的凭据，不能发给朋友。
- `共享 AI Token`：可以作为运营者入口文案；进入表单和规格后统一叫 `上游 AI Key`。
- `上游 AI Key`：provider key，只进入加密 vault。
- `MYC`：alpha 红包和额度兑换载体，不能包装成投资资产。
- `MyKey API Key`：朋友调用网关的 key，可复制、撤销。

对照当前代码的改造清单：

| 主流程步骤 | 当前代码落点 | 状态 | 最小改造 |
|-----------|-------------|------|---------|
| 进入原生 App `算力网关` | `src/components/ComputeGatewayManager.tsx` | ✅ 已有 | 把入口文案从「共享上游 AI Key」统一成「共享 AI Token」，表单字段继续说明“上游 API Token / Key”。 |
| 添加百炼/Kimi/OpenAI/Anthropic 共享 token | `buildProviderTokenSetupPayload()` + `setupProviderChannel()` | ✅ 已有 | 保持自动创建 provider token、price、routing；后续再给价格开放高级编辑，不进 MVP。 |
| 邀请朋友用模型 | `ComputeGatewayManager.tsx` 的 `inviteFriend()` | ✅ 已有 | 明确 `?redpacket=` 合一链接是新朋友唯一主入口；`/?redpacket=` 只作为已登录补发红包。 |
| 打开邀请链接并登录 | `cloud-gateway/src/index.ts` 的 `GET /accept` | ✅ 已有 | 已保留 `redpacket` 查询参数，并有回归测试；部署前确认线上 worker 已包含此修复。 |
| passkey 钱包 + 领取 MYC | `buyer-dashboard/src/components/RedpacketClaim.tsx`、`wallet.ts`、`/dashboard/claim` | ✅ 已有 | 领取失败释放红包的后端逻辑已有；前端文案继续保持“无需助记词、免 gas”。 |
| 立即兑换 AI 额度 | `RedpacketClaim.tsx`、`Topup.tsx`、`/dashboard/redeem-gasless` | ✅ 已有 | 兑换完成后不再把“创建 API key”作为第一下一步，而是进入 `AI 对话`。 |
| 在线使用和测试 | 当前无独立页面；只有 `/v1/responses` API relay | ❌ 缺口 | 新增 dashboard-session relay + `AI 对话` tab，让朋友不创建 API key 也能先试模型。 |
| 复制 API 使用 | `ApiKeys.tsx`、`/dashboard/api-keys`、`Docs.tsx` | ✅ 已有 | 定位改成“接入自己的客户端”，排在 `AI 对话` 之后。 |

推荐改造顺序：

1. **前端导航先收口。** 在 `buyer-dashboard/src/dashboardViewModel.ts` 增加 `chat` tab，让 `tabAfterRedpacketRedeem()` 返回 `chat`；导航改为 `AI 对话`、`MyKey API Key`、`余额 / 接入说明`，把渠道、日志、模型检测、额度请求等后台视图藏到高级入口。
2. **新增最小 `ChatPlayground`。** 文件建议 `buyer-dashboard/src/components/ChatPlayground.tsx`：模型选择、输入框、发送、结果区、错误/余额不足提示；不做 MCP、文件上传、联网搜索、长历史和多轮复杂会话。
3. **给 dashboard session 增加 relay 入口。** 在 `cloud-gateway/src/index.ts` 增 `POST /dashboard/responses`：先 `authenticateDashboard()` 得到 `accountId`，再复用现有 routing、provider token 解密、AccountActor reserve/settle/refund、request log persist。实现上最好先把 `handleRelayRoute()` 里“鉴权后 relay”的部分抽成 `handleRelayForAccount({ accountId, apiKeyId?: undefined, adapter, body })`，避免复制热路径。
4. **保留 OpenAI-compatible API Key，但降低心智优先级。** `ApiKeys.tsx` 文案改成“接入 Claude Code / OpenAI-compatible 客户端”，保留创建、复制 Base URL、复制 env、撤销；朋友先能在线跑，再决定是否复制。
5. **运营者端术语统一。** 原生 App 显示「共享 AI Token」；安全解释统一说“上游 API Token 只进入加密 vault，不会给朋友看”。`Admin Token` 始终只指运营者管理网关的凭据。
6. **补测试。** 已有 `/accept` 透传 redpacket、红包领取幂等、并发领取防双花测试；新增 `tabAfterRedpacketRedeem() === 'chat'`、`POST /dashboard/responses` 无需 API key 但会扣余额、API key raw key 只展示一次、ChatPlayground 余额不足/上游错误状态。

### 链：Sepolia 测试网（alpha 决定 2026-05-20）

`wrangler.toml` 配置 `TEMPO_CHAIN_ID=11155111`（Sepolia），与 project memory 里的「Tempo 主网」目标暂时不一致。**alpha 阶段有意留在 Sepolia**：红包领取 / gasless redeem 走测试网 MYC，不消耗真实价值。主网切换是后续动作，需同时确认 `MYC_TOKEN_ADDRESS` 在目标链上的部署与 relayer pool 充值。

### 下一步工作

1. **P0：实现 `AI 对话` 主入口。**
   - 后端：新增 dashboard-session relay，复用现有 `/v1/responses` 计费、路由、Account DO、request log。
   - 前端：新增 `ChatPlayground` tab，红包兑换完成后默认跳到这里。
   - 测试：dashboard session 无 API key 可调用、余额不足返回 402、上游错误会 refund reservation。
2. **P0：收窄朋友端 dashboard。**
   - 默认导航只保留 `AI 对话`、`MyKey API Key`、`余额 / 接入说明`。
   - `渠道`、`日志`、`模型检测`、`额度请求` 进高级入口或运营视图，避免朋友第一次进来像进后台。
3. **P0：统一运营者端术语。**
   - `算力网关` 第一屏使用「共享 AI Token」；表单解释保留“上游 API Token / Key”。
   - `邀请朋友用模型` 强调生成的是 `/accept?token=...&redpacket=...` 合一入口。
4. **P1：部署确认。**
   - `/accept` 透传 redpacket 的修复已有测试；线上 worker 仍需确认是否已部署。
   - 部署前跑 `cd cloud-gateway && npm test`，再按当前 Cloudflare 流程发布。
5. **P1：运营 runbook。**
   - 新增 `docs/compute-gateway-operator-runbook.md`：上游 token 添加、relayer pool 充值、红包口令生成、失败重试、stale reservation 观察、legal gate 文案边界。

### 原生 macOS passkey（Apple AuthenticationServices）脚手架（2026-05-22）

目标：把 passkey 从「localhost 当 RP ID 的 WebView/系统浏览器 hack」升级成绑定真实域名的原生 `AuthenticationServices`，用 WebAuthn **PRF** 派生对称密钥加密 vault/钱包。

**已落地并验证（编译通过）：**

| 部件 | 落点 | 状态 |
|------|------|------|
| AASA Worker | `cloudflare/passkey-aasa/`（worker.mjs + wrangler.toml + node:test） | ✅ 已部署 `https://mykey-passkey-aasa.v2eth.workers.dev/.well-known/apple-app-site-association`，返回 `{"webcredentials":{"apps":["6WTVNAVJGZ.com.mykey.desktop"]}}`，HTTP/2 200、application/json、无跳转 |
| Associated Domains entitlement | `src-tauri/Entitlements.plist` → `webcredentials:mykey-passkey-aasa.v2eth.workers.dev`，`tauri.conf.json` 的 `macOS.entitlements` 引用 | ✅ |
| 原生 bridge | `src-tauri/src/passkey_native.rs`（objc2-authentication-services，`ASAuthorizationController` + 平台 passkey provider + PRF register/assert，main-thread delegate + presentation anchor=Tauri NSWindow） | ✅ `cargo check` 通过 |
| Tauri 命令 | `commands::passkey_native_available / passkey_native_register / passkey_native_assert`（非 macOS 返回 error） | ✅ |
| 前端封装 + 接线 | `src/utils/passkeyNative.ts`；`GlobalSettings.tsx` 注册时优先原生、失败回退浏览器桥；`App.tsx` 解锁时按存储的 `rpId` 自动选原生 / 浏览器桥 | ✅ 类型干净、vite 构建通过 |

**运行时阻塞（重要）：** `com.apple.developer.associated-domains` 是 restricted entitlement。当前 App 是 ad-hoc 签名，该权限不生效；用本机 Apple Development 证书强签会被系统判定 restricted entitlement 而拒绝启动。**当前账号是免费个人 team，注册不了带 Associated Domains capability 的显式 App ID。** 因此原生 passkey 现在跑不通，前端会自动回退到 localhost 浏览器桥（今天仍可用）。

**解锁步骤（需要付费 Apple Developer Program $99/年）：**
1. portal → Identifiers → 把 `com.mykey.desktop` 注册成显式 App ID → 勾选 Associated Domains capability。
2. Profiles → 建 macOS Development provisioning profile（绑定 Apple Development 证书 `6WTVNAVJGZ` + 本机）。
3. 把 `.provisionprofile` 放进 `MyKey.app/Contents/embedded.provisionprofile`，用 Apple Development 身份重签；entitlements 要把 associated-domains **合并进**完整集合（保留 webview 需要的 `com.apple.security.cs.allow-jit` / `allow-unsigned-executable-memory` / `disable-library-validation`），否则 hardened runtime 会让 App 启动失败。
4. 测试期可给 entitlement 加 `?mode=developer` 并开启 Mac 的 Associated Domains 开发者模式以绕过 Apple CDN 缓存。
5. 正式版把 RP ID 从 workers.dev 换成自有域名（如 `mykey.im`），同步改 `NATIVE_PASSKEY_RP_ID`、AASA 的 host、Entitlements。

注：原生 passkey 绑定的是 workers.dev 域名 RP ID，与浏览器桥（localhost）创建的 passkey 是**不同凭据**，不可互换；解锁路径靠存储的 `rpId` 字段区分。

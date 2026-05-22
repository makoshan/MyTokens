# 多租户共享网关 — 实施计划（2026-05-21）

> 续 [`2026-05-20-v1-finishing.md`](./2026-05-20-v1-finishing.md)。方向：**一个部署，多运营者，各传各的上游 AI Token，互不可见。** 运营者 = 原生 app 用户，app 自助生成本地 key 注册身份（无邀请链接、不填全局 Admin Token）。MYC 已砍（见 [[compute-gateway-myc]]），免费走「邀请即充值」，未来付费走 USDC。

## 目标

把网关从**单租户**（一个全局 Admin Token 控制一切）改成**多租户**：每个运营者只能看/管自己的上游 Token、朋友账户、用量；平台 owner（你）保留全局 Admin Token 做平台运维。

## 非目标（本期不做）

- USDC 付费（独立后续）。
- 运营者自助注册的公开开放（alpha 仍靠"只把 app 发给信任的人"做天然 gating，或加一个准入码；不做开放注册）。
- 运营者之间共享/转售 Token。

## 角色 · 鉴权

| 角色 | 凭据 | 作用域 |
|---|---|---|
| 平台 owner | 全局 `ADMIN_TOKEN`（不变） | 平台运维：列运营者、停用运营者、健康检查 |
| 运营者 | **EVM keypair（原生 app 本地生成，存加密 vault）** → 换取 operator session | 只能动自己 `operator_id` 下的数据 |
| 朋友 | dashboard session（运营者邀请） | 只能动自己账户 |

**为什么用 EVM keypair**：原生 app 已经会 EIP-191 personal_sign（tcx-wasm，burnWithSig 在用），网关侧已用 viem 验签——直接复用。运营者身份 = 这把 key 的地址。

## 数据模型变更

新表：
```sql
CREATE TABLE compute_operators (
  id TEXT PRIMARY KEY,              -- op_<uuid>
  pubkey_address TEXT NOT NULL UNIQUE, -- EVM address (lowercased)
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active | disabled
  created_at TEXT NOT NULL
);
CREATE TABLE compute_operator_sessions (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  session_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
```

加 `operator_id` 列（migration `0004_multi_tenant.sql`）：
- `compute_provider_tokens.operator_id`（上游 Token 归属运营者）
- `compute_accounts.operator_id`（朋友账户归属运营者）
- `compute_routing_rules.operator_id`
- `compute_price_book.operator_id`

`compute_request_logs` / `compute_ledger_entries` 经 account 间接归属，不直接加列（查询 join account）。

**回填**：所有现存行 `operator_id = 'op_default'`（即你当前这个运营者），并插入一条 `compute_operators` 默认记录绑定你 app 的 key 地址。

## 运营者自助注册 & 登录（原生 app）

无邀请链接。app 第一次连网关：

1. **生成/取本地 key**：app 在 vault 里生成一把 EVM key（若已有则复用），地址 = `addr`。
2. **注册**：`POST /operator/register { address, display_name, sig, challenge }`——`sig` = personal_sign(challenge)，challenge 含 address + 时间戳防重放。网关验签 → 若 addr 未注册则建 `compute_operators` 记录 → 建 session。（alpha：可选 `access_code` 字段做准入 gating。）
3. **登录**：`POST /operator/login { address, challenge, sig }` → 验签 → 发 operator session（cookie/bearer，复用 dashboard session 那套 hash+store 机制）。
4. app 后续所有运营者请求带 operator session。

> session 过期就重新签一次 challenge 登录，本地 key 是长期身份，不发可泄露的长期 token。

## 鉴权改造

- 新增 `authenticateOperator(request, store, now) -> operatorId`（仿 `authenticateDashboard`，校验 operator session）。
- **运营者作用域路由**（取代现在用全局 Admin Token 的那批）改成 operator session 鉴权 + 自动按 `operatorId` 过滤/赋值：
  - `POST /operator/provider-tokens`（原 `/admin/provider-tokens`）：写入时带 `operator_id`。
  - `GET /operator/provider-tokens|routing-rules|accounts|usage`：查询带 `operator_id` 过滤。
  - `POST /operator/accounts`、`/operator/accounts/:id/invites`、`/operator/accounts/:id/manual-credit`：建账户带 `operator_id`；invite/credit 前校验该 account 属于本 operator。
- **平台 owner 路由**（保留全局 `ADMIN_TOKEN`）：`GET /admin/operators`、`POST /admin/operators/:id/disable`、健康检查。
- `/admin/*` 旧路由：保留给平台 owner，或逐步废弃；本期先并存。

## 请求路由按 operator 隔离（热路径）

`handleRelayForAccount` / `handleRelayRoute`：
- 拿到 friend 的 `account` → 读其 `operator_id`。
- `resolveRoutingRule` 只在**该 operator** 的 routing rules + provider tokens 里选（`store.listRoutingRules({operatorId})` / `listProviderTokenSummaries({operatorId})`）。
- 解密上游 Token 用该 operator 的（仍 `MASTER_KEY_V1` 加密，按 operator 隔离存储）。

这保证朋友 A（运营者甲）的请求只会用甲的上游 Token，绝不串到乙。

## 原生 app 改造（`ComputeGatewayManager.tsx`）

- 连接流程：从"填全局 Admin Token"→ 改成"app 自动注册/登录运营者身份"（生成本地 key → register/login → 存 operator session）。
- 所有 `adminGet/adminPost('/admin/...')` → 改成带 operator session 的 `/operator/...`。
- 文案：「Admin Token」只在"平台 owner"语境出现；运营者看到的是"已连接，身份已就绪"。

## 文件清单

- Migrate: `cloud-gateway/migrations/0004_multi_tenant.sql`
- Modify: `cloud-gateway/src/db/store.ts`（operators CRUD、session、各查询加 `operatorId` 过滤、provider token/account 写入带 operator_id）
- Modify: `cloud-gateway/src/index.ts`（`authenticateOperator`、`/operator/*` 路由、relay 按 operator 隔离、`/admin/operators` 平台路由）
- Create: `cloud-gateway/src/routes/operator-auth.ts`（challenge 生成 + 验签，viem `recoverMessageAddress`）
- Modify: `src/components/ComputeGatewayManager.tsx`（本地 key 注册/登录、改用 `/operator/*`）
- Modify: `src-tauri/`（如需在 Rust vault 存 operator key；或复用前端 tcx-wasm + vault）
- Tests: `cloud-gateway/tests/operator-tenancy.test.ts`

## 分期

1. **P0 数据 + 鉴权地基**：migration（operators 表 + operator_id 列 + 回填 op_default）、`authenticateOperator`、register/login（含验签）。
2. **P0 隔离写读**：provider-tokens / accounts / routing / usage 的 `/operator/*` 路由 + `operatorId` 过滤；relay 热路径按 operator 选路由。
3. **P1 原生 app 接管**：app 本地 key 注册登录 + 全面改用 `/operator/*`。
4. **P1 平台 owner 面**：`/admin/operators` 列表 + 停用。

## 测试（关键隔离断言）

- 运营者甲的 session **看不到/动不了** 乙的 provider token / 账户（403/404，不泄露存在性）。
- 朋友（甲名下）的 relay 只用甲的上游 Token；乙的 Token 在场也不会被选。
- register 验签：错签名 / 过期 challenge / 重放 → 拒绝。
- 回填后 `op_default` 拥有全部历史数据，旧 `/admin/*`（全局 token）仍可用（过渡）。
- 停用某 operator → 其朋友的 relay 被拒。

## 风险 & 法律

- **法律放大（Gate 1）**：多运营者各自转售自己的 provider 算力 → ToS 风险 × 人数 + 平台担责。**公开自助注册前必须过 Gate 1**；alpha 靠"只发给信任的人"+ 可选准入码。
- **"加密"边界**：网关替朋友调模型，必须能解密运营者的上游 Token → 平台（持 `MASTER_KEY_V1`）技术上能解密。诚实告知运营者：你的 Key 加密存储、其他运营者看不到，但平台方能用它调用。**做不到对平台的端到端加密**（除非改成运营者侧自托管代理，那是另一种架构）。
- **回填风险**：migration 给现存行赋 `op_default`，务必先备份 D1（`wrangler d1 export`）再 `migrate:remote`。
- **过渡期双轨**：旧 `/admin/*`（全局 token）与新 `/operator/*` 并存，避免一刀切打断现有 app；app 切过去后再废弃旧路由。

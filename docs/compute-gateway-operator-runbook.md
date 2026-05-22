# 算力网关运营 Runbook（operator day-2 ops）

> 面向**运营者**的日常操作手册。基建部署见 [`cloud-gateway/DEPLOY.md`](../cloud-gateway/DEPLOY.md)；本文件覆盖上线后的日常运营：上游 token、relayer pool、红包、失败重试、stale reservation、以及 **legal gate 文案边界**。
>
> 续 [`docs/superpowers/plans/2026-05-20-v1-finishing.md`](./superpowers/plans/2026-05-20-v1-finishing.md) 的 P1 #5。

## 0. 当前事实（2026-05-21）

| 项 | 值 |
|---|---|
| 链 | Ethereum **Sepolia**（alpha 有意留测试网），chainId `11155111` |
| RPC | `https://ethereum-sepolia-rpc.publicnode.com`（`TEMPO_RPC_URL`） |
| MYC token | `0x826fc283d2007A261347Cf4c0ff316e486506eBb`（6 decimals，`MYC_TOKEN_ADDRESS`） |
| 计价 | `MYC_MICRO_USD_PER_TOKEN=1000000` → **1 MYC = $1** |
| Relayer EOA（红包转账 + gasless burn，付 gas） | `0xc36fDC5eeee5599aEC0602e36020d4609d07eF3C`，私钥 = Worker secret `RELAYER_PRIVATE_KEY`。**不是 minter** |
| MYC owner / minter EOA | `0x131eFfAe2655747E9D0A8d5E289095C4C69805a0`（铸币 / 给 relayer pool 补 MYC 用） |

**Worker secrets**（`wrangler secret put <NAME>`，永不提交）：`SERVER_PEPPER`、`ADMIN_TOKEN`、`MASTER_KEY_V1`、`RELAYER_PRIVATE_KEY`。
**Worker vars**（`wrangler.toml`）：`ADMIN_IP_ALLOWLIST`、`ACCOUNT_RPM_LIMIT`、`TEMPO_RPC_URL`、`TEMPO_CHAIN_ID`、`MYC_TOKEN_ADDRESS`、`PUBLIC_GATEWAY_URL`。

---

## 1. 共享上游 AI Token（添加渠道）

**首选路径——原生 App `算力网关`：**

1. 打开 MyKey 原生 App → `算力网关`，填入 **运营者 Admin Token**（保存在本机加密 vault，不发给朋友）。
2. 「共享 AI Token」里选 provider（百炼 / Kimi / OpenAI / Anthropic），填模型 ID 和**上游 API Token / Key**。
3. 提交后 App 自动创建 provider token + price + routing rule（`setupProviderChannel()`）。

**底层 API（供脚本 / 排查）：** `POST /admin/provider-tokens`、`POST /admin/price-book`、`POST /admin/routing-rules`，均需 `Authorization: Bearer <ADMIN_TOKEN>` 且来源 IP 命中 `ADMIN_IP_ALLOWLIST`。上游明文 token 只进加密 vault（`MASTER_KEY_V1` 加密），审计日志只存 payload hash。

> ⚠️ 上游 token 失效 / 被封会让所有共享朋友断供。换 token：重新 `POST /admin/provider-tokens` 并把旧 channel `status=disabled`。`GET /admin/provider-tokens` 看当前 channel 健康度（`exhaustedUntil` / `lastResponseMs`）。

## 2. Relayer pool 充值

Relayer EOA 同时需要两样东西，否则红包领取 / gasless 兑换会失败：

- **Sepolia ETH（付 gas）：** 给 `0xc36fDC5e…07eF3C` 转 Sepolia ETH（水龙头或自有测试币）。低于约够几十笔 tx 就该补。
- **MYC（红包池）：** 红包从 relayer pool 转出，池子见底则领取失败。补池：用 **owner EOA** `0x131eFf…05a0` 给 relayer 转 MYC（owner 可铸；relayer 不可铸）。

查询（任意 EVM 工具 / cast）：relayer 的 ETH 余额、`balanceOf(relayer)` MYC 余额。建议每周或发大红包前检查。

> 切主网时（如 Base）：重新部署 MYC、改 `MYC_TOKEN_ADDRESS` / `TEMPO_CHAIN_ID` / `TEMPO_RPC_URL`、并给主网 relayer 充 ETH(L2 gas) + MYC。

## 3. 生成红包 / 邀请链接

**新朋友（唯一主入口）——原生 App `邀请朋友用模型`：** 填朋友名、模型、红包 MYC 数量 → 生成合一链接：

```
<PUBLIC_GATEWAY_URL>/accept?token=<invite>&redpacket=<code>
```

朋友打开 → passkey 建钱包 → 领 MYC → 免 gas 兑换额度 → **默认进 `AI 对话` 试用**（无需创建 API key）→ 需要接客户端时再复制 `sk-mykey_*`。

**已登录朋友补发红包：** 只发 `/?redpacket=<code>`（无 invite，不适合新朋友）。

**底层：** `POST /admin/redpackets {amount_myc, label}` → 返回 `code` / `claim_url`；`GET /admin/redpackets` 看状态（active / claimed / 领取地址）。

## 4. 失败重试

| 现象 | 原因 | 处理 |
|---|---|---|
| 领红包失败 | relayer ETH/MYC 不足 / RPC 抖动 | 见 §2 补池；红包领取做了并发防双花，失败会**释放红包**可重领 |
| gasless 兑换失败 | relayer gas 不足 / burn 验证失败 | 补 ETH；让朋友重试（burn tx hash 去重，重复提交安全） |
| `AI 对话` 报 `route_provider_adapter_mismatch` | 模型在 anthropic-compat 渠道 | 已自动回退 `/dashboard/messages`；若仍失败查 §1 渠道 |
| `AI 对话` 报余额不足 | 朋友额度耗尽 | 让其再领红包 / 充值 |
| relay 报 `provider_http_4xx/5xx` | 上游 token 失效 / 限流 | 查 `GET /admin/provider-tokens` 健康度，必要时换 token |

部署回滚：`wrangler rollback`（注意 DO migration 不可回滚 class，DO 改动先在 dev 跑）。

## 5. Stale reservation 观察

每次 relay 先 `reserve` 后 `settle`/`refund`。若请求中途断开未结算，`AccountDurableObject` 的 **DO alarm 会自动 refund 过期 reservation**（commit `6fadacc`）。日常无需手动干预；排查超花/余额对不上时：`GET /admin/usage` 看 request log，`GET /admin/audit-log` 看 admin 操作（只存 hash）。`/v1/balance`、`/dashboard/*` 余额一律走 DO，避免 race。

## 6. ⚠️ Legal gate 文案边界（务必遵守）

红包 / MYC **只面向受信朋友 alpha**，不是公开转售、投资型 token 或收益承诺。两个 gate **仍未通过**：

- **Gate 1：** provider（百炼/Kimi/OpenAI/Anthropic）的 aggregator/reseller 商务授权 —— ❌ 未取得。转售订阅算力可能违反 ToS（账号被封 → 所有朋友断供）。
- **Gate 2：** MYC 发行 / custody / money transmission / 证券风险的法律意见 —— ❌ 未取得。

**所有文案避免：**「公开卖模型」「MYC 升值 / 投资」「无限制转售 API」「保证收益」。

**可以说：** 运营者共享**已授权**的上游 AI Key，给朋友发**算力红包**；朋友兑换后在网页试用，或复制 MyKey API Key 接自己的 OpenAI-compatible 客户端。

**命名：** `Admin Token`=运营者管理凭据（不发朋友）；`共享 AI Token`=运营者入口文案；`上游 API Key`=provider key，只进加密 vault；`MYC`=红包/额度载体，非投资资产；`MyKey API Key`=朋友调用 key，可复制/撤销。

> 公开拉新（非朋友圈）前，必须先过 Gate 1 + Gate 2。pivot ≠ gate 已过。

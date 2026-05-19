# Deploying mykey-compute-gateway

End-to-end runbook for getting a fresh Cloudflare deploy live. All commands
run from `cloud-gateway/`.

## 0. Prerequisites

- A Cloudflare account with Workers + D1 enabled.
- Node 20+ and npm.
- `wrangler` is installed locally (`npm install` already pulled it in).
- An OpenAI API key and/or Anthropic API key for the first provider tokens.

## 1. Authenticate

```bash
npx wrangler login
```

Pops a browser. Use the account that will own the deploy.

## 2. Provision D1

```bash
npx wrangler d1 create mykey-compute-gateway
```

Wrangler prints a block like:

```toml
[[d1_databases]]
binding = "DB"
database_name = "mykey-compute-gateway"
database_id = "abc123-..."
```

Copy the `database_id` value into `wrangler.toml` (replace
`replace-with-cloudflare-d1-id`).

## 3. Generate and upload secrets

```bash
npm run gen-secrets
```

This prints:
- A `.dev.vars` block for local development. **Copy it to `.dev.vars`** (the
  file is gitignored). You will need this if you ever run `npm run dev`.
- Three `wrangler secret put` commands for production.

Run the three production secret commands. They are interactive — paste each
value when prompted (the printed `printf | wrangler secret put` form pipes
the value in non-interactively).

**Store the generated `MASTER_KEY_V1` in a password manager before you close
the terminal.** Rotating it requires re-uploading every provider token.

## 4. Apply migrations

```bash
npm run migrate:remote
```

Applies `migrations/0001_compute_gateway.sql` to the production D1.

## 5. Deploy the Worker

```bash
npm run deploy
```

Wrangler prints the public URL, e.g.
`https://mykey-compute-gateway.<account>.workers.dev`. Use that as the
gateway URL in the next step. If you want a custom hostname, add a `routes`
or `[[routes]]` block to `wrangler.toml` and re-deploy.

## 6. Bootstrap the first account

```bash
GATEWAY_URL=https://mykey-compute-gateway.<account>.workers.dev
ADMIN_TOKEN=<the admin token you uploaded in step 3>

npm run bootstrap -- \
  --gateway-url "$GATEWAY_URL" \
  --admin-token "$ADMIN_TOKEN" \
  --display-name "Friend Agent" \
  --openai-key "sk-..." \
  --anthropic-key "sk-ant-..."
```

The script prints:
- `account_id`
- `api_key` (the buyer's `Bearer sk-mykey_live_...` — shown **once**)
- `invite_url` (dashboard onboarding link)
- ready-to-run curl test commands

If you only have one provider, drop the flag for the other.

## 7. Smoke tests

```bash
# Account snapshot
curl "$GATEWAY_URL/v1/balance" -H "authorization: Bearer $API_KEY"

# OpenAI Responses
curl "$GATEWAY_URL/v1/responses" \
  -H "authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4.1-mini","input":"hello"}'

# Anthropic Messages
curl "$GATEWAY_URL/v1/messages" \
  -H "authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"claude-3-5-sonnet","messages":[{"role":"user","content":"hi"}],"max_tokens":64}'

# Streaming OpenAI (SSE on stdout)
curl -N "$GATEWAY_URL/v1/responses" \
  -H "authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4.1-mini","input":"hello","stream":true}'
```

## 7b. Lock the admin control plane to your IPs

By default `/admin/*` is reachable from anywhere with a valid `ADMIN_TOKEN`.
A leaked token is then a full takeover. Lock down by setting
`ADMIN_IP_ALLOWLIST` to a comma-separated list of IPv4 addresses or CIDR
blocks before the next deploy:

```bash
# Single office IP
npx wrangler deploy --var ADMIN_IP_ALLOWLIST:203.0.113.5

# Office subnet + bastion
npx wrangler deploy --var ADMIN_IP_ALLOWLIST:203.0.113.0/24,198.51.100.42
```

Or persist it in `wrangler.toml`'s `[vars]` block and redeploy.

Behavior:
- Empty / unset → no IP enforcement (dev convenience). Do not ship to
  production this way.
- Non-empty → request `cf-connecting-ip` (Cloudflare-provided) must match
  one of the entries. Else the request returns `403 admin_ip_denied`
  before the admin token is even checked, so the rejection does not leak
  whether `ADMIN_TOKEN` is configured.
- Falls back to `x-forwarded-for[0]` only when `cf-connecting-ip` is
  absent. Behind Cloudflare this header is always set, so the fallback is
  for self-hosted / local dev.

**Emergency unlock** (if you allowlist yourself out): edit the var via
`wrangler deploy --var ADMIN_IP_ALLOWLIST:""` from any network — the
`wrangler` CLI uses Cloudflare API auth (your account token), not the
gateway's `ADMIN_TOKEN`, so the lock cannot brick you.

## 7c. Per-account rate limit

The Account Durable Object enforces a sliding 60-second window on
reserve calls so a single account cannot drown the relay path. Set the
ceiling globally:

```bash
# 60 requests per minute per account
npx wrangler deploy --var ACCOUNT_RPM_LIMIT:60
```

- Empty / unset → no limit (default).
- Counter survives DO hibernation (persisted in storage alongside
  balance), so restart cannot accidentally let a flood through.
- `429` responses are OpenAI-compatible
  (`{ "error": { "code": "account_rate_limited", "type": "rate_limit_error" } }`)
  so SDKs that auto-retry on 429 already behave correctly.
- Per-account overrides (different limit per buyer) are a follow-up
  needing a new D1 column; for v1 alpha a single global ceiling is
  enough.

## 8. Common operational actions

```bash
# Pause an account (block all buyer API calls)
curl -X POST "$GATEWAY_URL/admin/accounts/<id>/manual-credit" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"amount_micro_usd":0}'   # noop credit — replace with admin pause when implemented

# Revoke a buyer API key
curl -X POST "$GATEWAY_URL/admin/api-keys/<key_id>/revoke" \
  -H "authorization: Bearer $ADMIN_TOKEN"

# Rotate / disable an upstream provider token (mark status disabled)
# Currently: re-upload the same id with status="disabled" via /admin/provider-tokens.

# Tail live logs
npx wrangler tail
```

## 9. Local development (optional)

```bash
cp .dev.vars.example .dev.vars
# paste real values from `npm run gen-secrets`, or generate fresh ones
npm run migrate:local
npm run dev
```

The worker listens on `http://127.0.0.1:8787`. Bootstrap is the same as
production, just point `--gateway-url` at `http://127.0.0.1:8787`.

## 10. CI / CD via GitHub Actions

The workflow at [.github/workflows/deploy-gateway.yml](../.github/workflows/deploy-gateway.yml)
runs tests on every tag push that matches `gateway-v*` (plus manual
`workflow_dispatch`), then waits for environment approval and runs the
remote D1 migration + `wrangler deploy`, then probes `/health`.

### One-time setup

1. **Create a Cloudflare API token** at
   https://dash.cloudflare.com/profile/api-tokens with these scopes:
   - Account → Workers Scripts → Edit
   - Account → D1 → Edit
   - Account → Account Settings → Read
   - Zone → Workers Routes → Edit (only if you bind a custom hostname)

2. **Find your account ID** in the Cloudflare dashboard (right sidebar of
   any Workers page).

3. **Add GitHub repository secrets** (Settings → Secrets and variables →
   Actions):

   | Secret | Value | Required |
   |---|---|---|
   | `CLOUDFLARE_API_TOKEN` | the token from step 1 | yes |
   | `CLOUDFLARE_ACCOUNT_ID` | account ID from step 2 | yes |
   | `GATEWAY_URL` | e.g. `https://mykey-compute-gateway.<acct>.workers.dev` | optional (smoke check skipped if unset) |

4. **Create the `production` environment** (Settings → Environments →
   New environment → `production`). Add yourself (or a small group) as a
   required reviewer. Every deploy then waits for explicit approval.

### Releasing

```bash
git tag gateway-v1.0.0
git push origin gateway-v1.0.0
```

The workflow runs tests → waits for `production` approval → applies D1
migrations → deploys → probes `/health`. Watch progress in the Actions
tab. The deploy step uses [`cloudflare/wrangler-action@v3`], so any
custom flags can be added via the `command:` input.

[`cloudflare/wrangler-action@v3`]: https://github.com/cloudflare/wrangler-action

### Skipping migrations

If you only need a worker redeploy (no schema change), trigger
`workflow_dispatch` from the Actions tab and tick `skip_migrations`.

### Upgrading to OIDC (optional, more secure)

`CLOUDFLARE_API_TOKEN` is a long-lived secret stored in GitHub. To move
to short-lived OIDC tokens:

1. In Cloudflare → Manage Account → API Tokens → Create OIDC role; bind
   it to your GitHub repository identity.
2. Replace the `apiToken:` input on the wrangler-action with the
   equivalent OIDC flow (see [Cloudflare OIDC docs](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)).
3. Add `permissions: id-token: write` to the deploy job.

Not required for v1 alpha — API token is simpler and acceptable for a
small operator team.

## 11. Rollback

`wrangler` stores every deploy. To roll back:

```bash
npx wrangler deployments list
npx wrangler deployments view <deployment-id>
npx wrangler rollback <deployment-id>
```

Database changes are not rolled back automatically — D1 migrations are
forward-only. If a migration introduces a breaking change, write a new
migration to revert.

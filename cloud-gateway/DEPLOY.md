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

## 10. Rollback

`wrangler` stores every deploy. To roll back:

```bash
npx wrangler deployments list
npx wrangler deployments view <deployment-id>
npx wrangler rollback <deployment-id>
```

Database changes are not rolled back automatically — D1 migrations are
forward-only. If a migration introduces a breaking change, write a new
migration to revert.

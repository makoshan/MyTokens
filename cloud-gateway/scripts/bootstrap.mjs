#!/usr/bin/env node
// One-shot bootstrap for a fresh gateway: create an account, upload provider
// tokens, seed the price book + routing, mint an API key, and (optionally)
// issue a dashboard invite. Outputs the buyer-facing credentials at the end.
//
// Usage:
//   node scripts/bootstrap.mjs \
//     --gateway-url https://api.mykey.example \
//     --admin-token "$ADMIN_TOKEN" \
//     --display-name "Friend Agent" \
//     [--openai-key sk-...] \
//     [--anthropic-key sk-ant-...]

import { argv, exit } from 'node:process'

function parseArgs(args) {
  const out = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true'
    out[key] = value
    if (value !== 'true') i += 1
  }
  return out
}

const args = parseArgs(argv.slice(2))
const gatewayUrl = args['gateway-url']
const adminToken = args['admin-token']
const displayName = args['display-name'] ?? 'Default Account'
const accountGroup = args['account-group'] ?? 'friends'
const openaiKey = args['openai-key']
const anthropicKey = args['anthropic-key']
const initialCredit = Number(args['initial-credit-micro-usd'] ?? 5_000_000)

if (!gatewayUrl || !adminToken) {
  console.error('Missing --gateway-url or --admin-token.')
  console.error('Try: node scripts/bootstrap.mjs --gateway-url https://api.mykey.example --admin-token $ADMIN_TOKEN --openai-key sk-...')
  exit(1)
}

if (!openaiKey && !anthropicKey) {
  console.error('Provide at least one of --openai-key or --anthropic-key.')
  exit(1)
}

async function adminFetch(path, init = {}) {
  const response = await fetch(`${gatewayUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!response.ok) {
    const repro = `curl -X ${init.method ?? 'GET'} ${gatewayUrl}${path} -H "Authorization: Bearer $ADMIN_TOKEN"${init.body ? ` -d '${init.body}'` : ''}`
    console.error(`\nadmin ${path} -> HTTP ${response.status}`)
    console.error(body)
    console.error(`Repro: ${repro}`)
    exit(1)
  }
  return body
}

console.log(`> Creating account "${displayName}" in group "${accountGroup}"...`)
const account = await adminFetch('/admin/accounts', {
  method: 'POST',
  body: JSON.stringify({
    display_name: displayName,
    account_group: accountGroup,
    default_provider: openaiKey ? 'openai' : 'anthropic',
    default_model: openaiKey ? 'gpt-4.1-mini' : 'claude-3-5-sonnet',
  }),
})
const accountId = account.id
console.log(`  account_id=${accountId}`)

if (initialCredit > 0) {
  console.log(`> Crediting ${initialCredit} micro-USD...`)
  await adminFetch(`/admin/accounts/${accountId}/manual-credit`, {
    method: 'POST',
    body: JSON.stringify({ amount_micro_usd: initialCredit }),
  })
}

if (openaiKey) {
  console.log('> Uploading OpenAI provider token + price book + routing rule...')
  await adminFetch('/admin/provider-tokens', {
    method: 'POST',
    body: JSON.stringify({
      id: 'tok-openai-default',
      provider: 'openai',
      adapter: 'openai',
      label: 'openai-bootstrap',
      plaintext: openaiKey,
      models: ['gpt-4.1-mini'],
      priority: 1,
      weight: 10,
    }),
  })
  await adminFetch('/admin/price-book', {
    method: 'POST',
    body: JSON.stringify({
      id: 'price-openai-gpt-4-1-mini',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      version: 1,
      sell_input_micro_usd_per_1m_tokens: 400_000,
      sell_output_micro_usd_per_1m_tokens: 1_600_000,
      upstream_input_micro_usd_per_1m_tokens: 250_000,
      upstream_output_micro_usd_per_1m_tokens: 1_000_000,
    }),
  })
  await adminFetch('/admin/routing-rules', {
    method: 'POST',
    body: JSON.stringify({
      id: 'route-openai-gpt-4-1-mini',
      account_group: accountGroup,
      requested_model: 'gpt-4.1-mini',
      requested_provider: 'openai',
      provider_token_id: 'tok-openai-default',
      actual_provider_model: 'gpt-4.1-mini',
      priority: 1,
      weight: 10,
    }),
  })
}

if (anthropicKey) {
  console.log('> Uploading Anthropic provider token + price book + routing rule...')
  await adminFetch('/admin/provider-tokens', {
    method: 'POST',
    body: JSON.stringify({
      id: 'tok-anthropic-default',
      provider: 'anthropic',
      adapter: 'anthropic',
      label: 'anthropic-bootstrap',
      plaintext: anthropicKey,
      models: ['claude-3-5-sonnet'],
      priority: 1,
      weight: 10,
    }),
  })
  await adminFetch('/admin/price-book', {
    method: 'POST',
    body: JSON.stringify({
      id: 'price-anthropic-claude-3-5-sonnet',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      version: 1,
      sell_input_micro_usd_per_1m_tokens: 4_500_000,
      sell_output_micro_usd_per_1m_tokens: 22_500_000,
      upstream_input_micro_usd_per_1m_tokens: 3_000_000,
      upstream_output_micro_usd_per_1m_tokens: 15_000_000,
    }),
  })
  await adminFetch('/admin/routing-rules', {
    method: 'POST',
    body: JSON.stringify({
      id: 'route-anthropic-claude-3-5-sonnet',
      account_group: accountGroup,
      requested_model: 'claude-3-5-sonnet',
      requested_provider: 'anthropic',
      provider_token_id: 'tok-anthropic-default',
      actual_provider_model: 'claude-3-5-sonnet',
      priority: 1,
      weight: 10,
    }),
  })
}

console.log('> Minting first API key...')
const apiKey = await adminFetch(`/admin/accounts/${accountId}/api-keys`, {
  method: 'POST',
  body: JSON.stringify({ name: 'bootstrap key' }),
})

console.log('> Creating dashboard invite...')
const invite = await adminFetch(`/admin/accounts/${accountId}/invites`, {
  method: 'POST',
  body: JSON.stringify({}),
})

console.log('\n=== bootstrap complete ===')
console.log(`account_id        ${accountId}`)
console.log(`api_key           ${apiKey.raw_key}`)
console.log(`invite_url        ${invite.invite_url}`)
console.log(`balance_micro_usd ${initialCredit}`)
console.log('\nTest the buyer API:')
if (openaiKey) {
  console.log(`  curl ${gatewayUrl}/v1/responses \\
    -H "authorization: Bearer ${apiKey.raw_key}" \\
    -H "content-type: application/json" \\
    -d '{"model":"gpt-4.1-mini","input":"hello"}'`)
}
if (anthropicKey) {
  console.log(`  curl ${gatewayUrl}/v1/messages \\
    -H "authorization: Bearer ${apiKey.raw_key}" \\
    -H "content-type: application/json" \\
    -d '{"model":"claude-3-5-sonnet","messages":[{"role":"user","content":"hi"}],"max_tokens":64}'`)
}
console.log(`\nBalance:  curl ${gatewayUrl}/v1/balance -H "authorization: Bearer ${apiKey.raw_key}"`)

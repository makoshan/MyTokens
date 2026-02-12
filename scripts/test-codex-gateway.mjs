#!/usr/bin/env node

const baseUrl = (process.env.OPENAI_BASE_URL || 'http://127.0.0.1:8888').replace(/\/+$/, '')
const apiKey = process.env.OPENAI_API_KEY || 'dummy'
const model = process.env.MODEL || 'gpt-5-codex'

async function requestJson(url, init = {}) {
  const res = await fetch(url, init)
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { ok: res.ok, status: res.status, body }
}

async function main() {
  console.log(`Gateway base: ${baseUrl}`)

  const health = await requestJson(`${baseUrl}/health`)
  if (!health.ok) {
    console.error(`Health check failed: HTTP ${health.status}`)
    console.error(health.body)
    process.exit(1)
  }
  console.log('Health ok:', health.body)

  const models = await requestJson(`${baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!models.ok) {
    console.error(`Models check failed: HTTP ${models.status}`)
    console.error(models.body)
    process.exit(1)
  }
  console.log(
    'Models:',
    Array.isArray(models.body?.data) ? models.body.data.map((m) => m.id).join(', ') : models.body
  )

  const payload = {
    model,
    input: 'Reply exactly: gateway-ok',
    stream: false,
  }
  const responses = await requestJson(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!responses.ok) {
    console.error(`Responses call failed: HTTP ${responses.status}`)
    console.error(JSON.stringify(responses.body, null, 2))
    process.exit(2)
  }

  console.log('Responses call ok.')
  console.log(JSON.stringify(responses.body, null, 2))
}

main().catch((err) => {
  const code = err?.cause?.code || err?.code
  if (code === 'ECONNREFUSED' || code === 'EPERM') {
    console.error(`Gateway test crashed: cannot connect to ${baseUrl} (${code}).`)
    console.error('Hint: start MyKey app and make sure Gateway service is running.')
    if (code === 'EPERM') {
      console.error('Hint: this can also happen in restricted/sandboxed terminals that block local network.')
    }
    process.exit(98)
  }
  console.error('Gateway test crashed:', err?.message || err)
  process.exit(99)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { matchesCidr, matchesCidrList, parseCidrList } from '../src/admin-ip.js'
import { InMemoryGatewayStore } from '../src/db/store.js'
import { createGatewayApp } from '../src/index.js'

function seedStore() {
  return new InMemoryGatewayStore({
    baseUrl: 'https://api.mykey.example',
    accounts: [],
  })
}

test('parseCidrList accepts single IPs, /32, /24, and discards garbage', () => {
  const specs = parseCidrList('1.2.3.4, 10.0.0.0/24,  ignored , 192.168.1.1/32 , bogus.example')
  assert.equal(specs.length, 3)
  assert.equal(specs[0].prefix, 32)
  assert.equal(specs[1].prefix, 24)
  assert.equal(specs[2].prefix, 32)
})

test('matchesCidr handles /24 boundaries correctly', () => {
  const [spec] = parseCidrList('10.0.0.0/24')
  assert.equal(matchesCidr('10.0.0.1', spec), true)
  assert.equal(matchesCidr('10.0.0.255', spec), true)
  assert.equal(matchesCidr('10.0.1.0', spec), false)
  assert.equal(matchesCidr('not-an-ip', spec), false)
})

test('matchesCidrList accepts when any spec matches and rejects otherwise', () => {
  const specs = parseCidrList('192.168.0.0/16,10.0.0.5')
  assert.equal(matchesCidrList('192.168.42.7', specs), true)
  assert.equal(matchesCidrList('10.0.0.5', specs), true)
  assert.equal(matchesCidrList('10.0.0.6', specs), false)
})

test('empty allowlist leaves /admin/* open (dev-friendly default)', async () => {
  const store = seedStore()
  const app = createGatewayApp({
    store,
    pepper: 'p',
    adminToken: 'admin-secret',
    baseUrl: 'https://dashboard.mykey.example',
    now: () => '2026-05-20T00:00:00Z',
  })

  const response = await app.fetch(
    new Request('https://gateway.test/admin/accounts', {
      headers: { authorization: 'Bearer admin-secret' },
    })
  )
  assert.equal(response.status, 200)
})

test('configured allowlist denies non-matching cf-connecting-ip even with a valid admin token', async () => {
  const store = seedStore()
  const app = createGatewayApp({
    store,
    pepper: 'p',
    adminToken: 'admin-secret',
    adminIpAllowlist: ['203.0.113.0/24'],
    baseUrl: 'https://dashboard.mykey.example',
    now: () => '2026-05-20T00:00:00Z',
  })

  const denied = await app.fetch(
    new Request('https://gateway.test/admin/accounts', {
      headers: { authorization: 'Bearer admin-secret', 'cf-connecting-ip': '198.51.100.7' },
    })
  )
  const deniedBody = (await denied.json()) as { error: { code: string } }
  assert.equal(denied.status, 403)
  assert.equal(deniedBody.error.code, 'admin_ip_denied')
})

test('configured allowlist accepts a matching cf-connecting-ip and still demands the admin token', async () => {
  const store = seedStore()
  const app = createGatewayApp({
    store,
    pepper: 'p',
    adminToken: 'admin-secret',
    adminIpAllowlist: '203.0.113.0/24',
    baseUrl: 'https://dashboard.mykey.example',
    now: () => '2026-05-20T00:00:00Z',
  })

  const allowedButNoToken = await app.fetch(
    new Request('https://gateway.test/admin/accounts', {
      headers: { 'cf-connecting-ip': '203.0.113.42' },
    })
  )
  assert.equal(allowedButNoToken.status, 401)

  const allowed = await app.fetch(
    new Request('https://gateway.test/admin/accounts', {
      headers: { authorization: 'Bearer admin-secret', 'cf-connecting-ip': '203.0.113.42' },
    })
  )
  assert.equal(allowed.status, 200)
})

test('missing cf-connecting-ip with a non-empty allowlist is denied', async () => {
  const store = seedStore()
  const app = createGatewayApp({
    store,
    pepper: 'p',
    adminToken: 'admin-secret',
    adminIpAllowlist: ['203.0.113.0/24'],
    baseUrl: 'https://dashboard.mykey.example',
    now: () => '2026-05-20T00:00:00Z',
  })

  const response = await app.fetch(
    new Request('https://gateway.test/admin/accounts', {
      headers: { authorization: 'Bearer admin-secret' },
    })
  )
  const payload = (await response.json()) as { error: { code: string } }
  assert.equal(response.status, 403)
  assert.equal(payload.error.code, 'admin_ip_denied')
})

test('x-forwarded-for is honored when cf-connecting-ip is absent', async () => {
  const store = seedStore()
  const app = createGatewayApp({
    store,
    pepper: 'p',
    adminToken: 'admin-secret',
    adminIpAllowlist: ['203.0.113.0/24'],
    baseUrl: 'https://dashboard.mykey.example',
    now: () => '2026-05-20T00:00:00Z',
  })

  const response = await app.fetch(
    new Request('https://gateway.test/admin/accounts', {
      headers: {
        authorization: 'Bearer admin-secret',
        'x-forwarded-for': '203.0.113.99, 10.0.0.1',
      },
    })
  )
  assert.equal(response.status, 200)
})

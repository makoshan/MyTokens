import assert from 'node:assert/strict'
import test from 'node:test'
import { loadDashboardSnapshot } from '../src/api.js'

test('loadDashboardSnapshot returns server data and does not use demo fallback', async () => {
  const snapshot = {
    account: { id: 'acct-1', displayName: 'Server Account', status: 'active' },
    balanceMicroUsd: 1,
    todaySpendMicroUsd: 0,
    baseUrl: 'https://api.mykey.example',
    apiKeys: [],
    channels: [],
    routingRules: [],
    usage: [],
    modelQuality: [],
    creditRequests: [],
  }

  const loaded = await loadDashboardSnapshot(async () => Response.json(snapshot))

  assert.equal(loaded.account.displayName, 'Server Account')
})

test('loadDashboardSnapshot throws on unauthenticated or failed dashboard API responses', async () => {
  await assert.rejects(
    () => loadDashboardSnapshot(async () => Response.json({ error: { code: 'dashboard_auth_required' } }, { status: 401 })),
    /dashboard_api_failed:401/
  )

  await assert.rejects(
    () => loadDashboardSnapshot(async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })),
    /dashboard_api_invalid_response:200/
  )

  await assert.rejects(
    () =>
      loadDashboardSnapshot(async () => {
        throw new Error('network down')
      }),
    /network down/
  )
})

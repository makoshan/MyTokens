import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildComputeAdminHeaders,
  normalizeComputeAccountSummary,
} from '../src/utils/computeGateway'
import type { ComputeAccount } from '../src/types/compute'

test('buildComputeAdminHeaders redacts raw key from display while sending bearer auth', () => {
  const headers = buildComputeAdminHeaders('admin-secret')

  assert.equal(headers.authorization, 'Bearer admin-secret')
  assert.equal(headers['content-type'], 'application/json')
})

test('normalizeComputeAccountSummary produces operator-facing balances and status', () => {
  const account: ComputeAccount = {
    id: 'acct-1',
    displayName: 'Friends Alpha',
    status: 'active',
    accountGroup: 'friends',
    balanceMicroUsd: 12_345_678,
    reservedMicroUsd: 345_678,
    apiKeyCount: 2,
    dailyBudgetMicroUsd: 50_000_000,
    createdAt: '2026-05-19T00:00:00Z',
    updatedAt: '2026-05-19T00:00:00Z',
  }

  const summary = normalizeComputeAccountSummary(account)

  assert.equal(summary.availableMicroUsd, 12_000_000)
  assert.equal(summary.balanceLabel, '$12.35')
  assert.equal(summary.availableLabel, '$12.00')
  assert.equal(summary.operatorStatus, 'active / friends')
})

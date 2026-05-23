import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = new URL('../..', import.meta.url).pathname

test('invite claim dismissal syncs React lock state from passkey storage', () => {
  const app = readFileSync(join(root, 'src/App.tsx'), 'utf8')
  const syncCalls = app.match(/setLocked\(appLockStateAfterInviteClaimDismiss\(isPasskeyLocked\(\)\)\)/g) ?? []
  assert.equal(syncCalls.length, 2)
})

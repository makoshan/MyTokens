import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const gatewayPath = join(root, 'src-tauri', 'src', 'gateway.rs')
const gateway = readFileSync(gatewayPath, 'utf8')

const requiredRoutes = [
  '/v1/models',
  '/v1/responses',
  '/v1/messages',
  '/v1/chat/completions',
]

assert.match(gateway, /127\.0\.0\.1/, 'local gateway must keep binding to localhost')
for (const route of requiredRoutes) {
  assert.ok(gateway.includes(route), `local gateway must expose ${route}`)
}

console.log(`gateway source check passed: ${requiredRoutes.join(', ')}`)

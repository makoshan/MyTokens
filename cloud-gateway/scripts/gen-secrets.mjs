#!/usr/bin/env node
// Generates strong random values for the three gateway secrets and prints
// ready-to-paste lines for both .dev.vars (local) and `wrangler secret put`
// (production).
import { randomBytes } from 'node:crypto'

function base64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex')
}

const serverPepper = hex(randomBytes(32))
const adminToken = base64(randomBytes(32)).replace(/=+$/g, '')
const masterKeyV1 = base64(randomBytes(32))

const localFile = `SERVER_PEPPER=${serverPepper}
ADMIN_TOKEN=${adminToken}
MASTER_KEY_V1=${masterKeyV1}
PUBLIC_GATEWAY_URL=http://127.0.0.1:8787
`

const remoteCommands = `# Run these from the cloud-gateway/ directory after \`wrangler login\`.
printf %s ${JSON.stringify(serverPepper)} | npx wrangler secret put SERVER_PEPPER
printf %s ${JSON.stringify(adminToken)} | npx wrangler secret put ADMIN_TOKEN
printf %s ${JSON.stringify(masterKeyV1)} | npx wrangler secret put MASTER_KEY_V1
`

const out = `# === Local development (.dev.vars) ===
${localFile}
# === Production secrets ===
${remoteCommands}
# Keep the master key for the lifetime of any provider tokens you encrypt
# with it — rotating it means re-uploading every provider token. Store a copy
# in your password manager BEFORE running \`wrangler secret put\`.
`

process.stdout.write(out)

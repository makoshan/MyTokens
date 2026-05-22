#!/usr/bin/env node
// tcx-keygen.mjs — keystore sidecar for the `mykey` CLI.
//
// Generates or imports a tcx-wasm keystore and derives the account address,
// using the SAME @consenlabs/tcx-wasm build the desktop app's frontend uses
// (src/utils/tcxWallet.ts). This guarantees the keystore the CLI stores can
// later be unlocked + signed by the GUI.
//
// Protocol: read one JSON request on stdin, write one JSON response on stdout.
//   request : { unlockSecret, network?, mnemonic?, keystoreJson?, derivation }
//             derivation = { chain, network, derivationPath, chainId?, segWit? }
//   response: { keystoreJson, accounts: [{ address, chain, derivationPath, ... }] }
// Any failure prints {"error": "..."} to stdout and exits non-zero.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// The package only declares a bundler `module` field (no `main`/`exports`), so
// Node can't resolve the bare specifier — import the published file directly.
import { initSync, create_keystore, derive_accounts } from '@consenlabs/tcx-wasm/tcx_wasm.js'

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => (buf += d))
    process.stdin.on('end', () => resolve(buf))
    process.stdin.on('error', reject)
  })
}

async function main() {
  // tcx-wasm is a wasm-bindgen `web` build: in Node we feed it the wasm bytes
  // synchronously (the default async init would try to `fetch()` a file URL).
  const require = createRequire(import.meta.url)
  const wasmPath = require.resolve('@consenlabs/tcx-wasm/tcx_wasm_bg.wasm')
  initSync({ module: readFileSync(wasmPath) })

  const req = JSON.parse((await readStdin()) || '{}')
  const unlockSecret = String(req.unlockSecret || '').trim()
  if (!unlockSecret) throw new Error('unlockSecret is required')
  if (!req.derivation || !req.derivation.chain) throw new Error('derivation is required')

  let keystoreJson = req.keystoreJson
  if (!keystoreJson) {
    const payload = { network: req.network || 'MAINNET', password: unlockSecret }
    if (req.mnemonic && String(req.mnemonic).trim()) payload.mnemonic = String(req.mnemonic).trim()
    keystoreJson = create_keystore(JSON.stringify(payload))
  }

  const accounts = JSON.parse(
    derive_accounts(
      JSON.stringify({ keystoreJson, key: unlockSecret, derivations: [req.derivation] }),
    ),
  )

  process.stdout.write(JSON.stringify({ keystoreJson, accounts }))
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: String(err && err.message ? err.message : err) }))
  process.exit(1)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = process.cwd()

function readRepoFile(path: string) {
  return readFileSync(join(repoRoot, path), 'utf8')
}

test('macOS desktop app uses a MyKey-specific executable name', () => {
  const cargoToml = readRepoFile('src-tauri/Cargo.toml')
  const desktopBin = /\[\[bin\]\]\s+name = "mykey-desktop"\s+path = "src\/main\.rs"/m

  assert.match(cargoToml, /^name = "mykey-desktop"$/m)
  assert.match(cargoToml, /^default-run = "mykey-desktop"$/m)
  assert.match(cargoToml, desktopBin)
  assert.doesNotMatch(cargoToml, /^name = "app"$/m)
  assert.doesNotMatch(cargoToml, /^default-run = "app"$/m)
})

test('web entrypoint uses the bundled MyKey icon instead of the Vite default', () => {
  const html = readRepoFile('src/index.html')

  assert.match(html, /href="\/icons\/icon\.png"/)
  assert.doesNotMatch(html, /vite\.svg/)
})

test('release localhost main window keeps the default Tauri permissions', () => {
  const libRs = readRepoFile('src-tauri/src/lib.rs')
  const start = libRs.indexOf('CapabilityBuilder::new("localhost-ui")')
  const end = libRs.indexOf('        )?;', start)
  const localhostCapability = start >= 0 && end >= 0 ? libRs.slice(start, end) : ''

  assert.match(localhostCapability, /\.remote\(url\.to_string\(\)\)/)
  assert.match(localhostCapability, /\.window\("main"\)/)
  assert.match(localhostCapability, /\.permission\("core:default"\)/)
  assert.match(localhostCapability, /\.permission\("dialog:default"\)/)
  assert.match(localhostCapability, /\.permission\("global-shortcut:default"\)/)
})

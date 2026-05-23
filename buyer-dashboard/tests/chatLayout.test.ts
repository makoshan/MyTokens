import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = new URL('../..', import.meta.url).pathname

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

function cssRule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))
  assert.ok(match, `missing CSS rule for ${selector}`)
  return match[1]
}

test('chat top-up action stays grouped with the balance instead of becoming a toolbar row', () => {
  const component = readProjectFile('src/components/ChatPlayground.tsx')
  const balanceBlock = component.match(/<div className="chat-balance">([\s\S]*?)<\/div>\s*<\/div>/)?.[1] ?? ''

  assert.match(balanceBlock, /className="chat-balance-row"/)
  assert.match(balanceBlock, /className="chat-topup-btn"/)
})

test('chat balance and top-up button use a compact inline layout', () => {
  const styles = readProjectFile('src/styles.css')

  assert.match(cssRule(styles, '.chat-balance-row'), /display:\s*flex/)
  assert.match(cssRule(styles, '.chat-balance-row'), /justify-content:\s*flex-end/)
  assert.match(cssRule(styles, '.chat-topup-btn'), /min-height:\s*32px/)
})

test('chat MCP and Skills capabilities are off by default', () => {
  const component = readProjectFile('src/components/ChatPlayground.tsx')

  assert.match(
    component,
    /const DEFAULT_CAPABILITIES:\s*ChatCapabilityId\[\]\s*=\s*\[\]/
  )
  assert.match(
    component,
    /useState<ChatCapabilityId\[\]>\(DEFAULT_CAPABILITIES\)/
  )
  assert.doesNotMatch(
    component,
    /useState<ChatCapabilityId\[\]>\(\['mcp', 'skills'\]\)/
  )
})

test('starting a new chat resets MCP and Skills back off', () => {
  const component = readProjectFile('src/components/ChatPlayground.tsx')

  assert.match(
    component,
    /setMessages\(\[\]\)[\s\S]*setError\(''\)[\s\S]*setEnabledCapabilities\(DEFAULT_CAPABILITIES\)/
  )
  assert.match(
    component,
    /useEffect\(\(\) => \{[\s\S]*setEnabledCapabilities\(DEFAULT_CAPABILITIES\)[\s\S]*\}, \[snapshot\.account\.id\]\)/
  )
})

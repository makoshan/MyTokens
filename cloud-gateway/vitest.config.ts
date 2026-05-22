import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Boots a real workerd runtime so the AccountDurableObject is exercised under
// Cloudflare's actual single-instance + storage + alarm semantics — not just
// our in-process fake. The node:test suite (`npm test`) still owns the bulk
// of algorithmic coverage; this config only picks up tests-workers/*.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.toml' } })],
  test: {
    include: ['tests-workers/**/*.test.ts'],
  },
})

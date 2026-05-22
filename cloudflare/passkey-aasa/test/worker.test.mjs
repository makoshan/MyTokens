import { strict as assert } from 'node:assert'
import test from 'node:test'
import worker from '../src/worker.mjs'

test('serves apple app site association for webcredentials', async () => {
  const env = {
    APPLE_APP_ID: 'A32Q4A82E2.com.mykey.desktop',
  }

  const response = await worker.fetch(
    new Request('https://mykey-passkey-aasa.test/.well-known/apple-app-site-association'),
    env
  )
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json')
  assert.deepEqual(body, {
    webcredentials: {
      apps: ['A32Q4A82E2.com.mykey.desktop'],
    },
  })
})

test('returns not found for unrelated paths', async () => {
  const response = await worker.fetch(new Request('https://mykey-passkey-aasa.test/'), {
    APPLE_APP_ID: 'A32Q4A82E2.com.mykey.desktop',
  })

  assert.equal(response.status, 404)
})

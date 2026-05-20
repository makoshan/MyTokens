import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  OKLINK_DOCS_URL,
  OKLINK_EXPLORER_BASE_URL,
  buildOklinkExplorerUrl,
  maskOklinkApiKey,
} from '../src/utils/oklinkApi'

test('buildOklinkExplorerUrl creates an OKLink Explorer API URL with query params', () => {
  assert.equal(
    buildOklinkExplorerUrl('/api/v5/explorer/address/address-summary', {
      chainShortName: 'ETH',
      address: '0xff709659a2646d734ea5735829de2b2f51f82c27',
    }),
    'https://www.oklink.com/api/v5/explorer/address/address-summary?chainShortName=ETH&address=0xff709659a2646d734ea5735829de2b2f51f82c27'
  )
})

test('buildOklinkExplorerUrl rejects non-API paths', () => {
  assert.throws(() => buildOklinkExplorerUrl('https://evil.example/api', {}), /OKLink API path/)
})

test('maskOklinkApiKey keeps only a short preview', () => {
  assert.equal(maskOklinkApiKey('12345678-1234-1234-1234-123456789abc'), '1234...9abc')
  assert.equal(maskOklinkApiKey('short'), '••••••')
})

test('OKLink constants point to the official docs and API host', () => {
  assert.equal(OKLINK_DOCS_URL, 'https://www.oklink.com/docs/zh/#explorer-introduction')
  assert.equal(OKLINK_EXPLORER_BASE_URL, 'https://www.oklink.com')
})

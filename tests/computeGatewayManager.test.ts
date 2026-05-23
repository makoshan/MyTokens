import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

function source(path: string) {
  return readFileSync(join(root, path), 'utf8')
}

test('compute gateway invite list exposes delete separately from revoke', () => {
  const component = source('src/components/ComputeGatewayManager.tsx')

  assert.match(component, /async function operatorDelete/)
  assert.match(component, /async function deleteInvite/)
  assert.match(component, /\/operator\/invites\/\$\{invite\.id\}/)
  assert.match(component, /删除中…/)
  assert.match(component, /删除只移除这条分享记录/)
})

test('compute gateway share-link actions stay compact in table rows', () => {
  const css = source('src/components/ComputeGatewayManager.css')

  assert.match(css, /\.compute-gateway-manager__share-table/)
  assert.match(css, /\.compute-gateway-manager__share-table td:nth-child\(4\)[\s\S]*?max-width:\s*0/)
  assert.match(css, /\.compute-gateway-manager__share-table td:nth-child\(4\)[\s\S]*?overflow:\s*hidden/)
  assert.match(css, /\.compute-gateway-manager__row-actions[\s\S]*?flex-wrap:\s*nowrap/)
  assert.match(css, /\.compute-gateway-manager__row-actions button[\s\S]*?min-height:\s*30px/)
  assert.match(css, /\.compute-gateway-manager__invite-link[\s\S]*?display:\s*block/)
  assert.match(css, /\.compute-gateway-manager__invite-link[\s\S]*?max-width:\s*100%/)
  assert.match(css, /\.compute-gateway-manager__action-delete/)
})

test('compute gateway share-link list is paginated', () => {
  const component = source('src/components/ComputeGatewayManager.tsx')
  const css = source('src/components/ComputeGatewayManager.css')

  assert.match(component, /const INVITE_PAGE_SIZE\s*=\s*8/)
  assert.match(component, /const \[invitePage,\s*setInvitePage\]/)
  assert.match(component, /pagedInvites\s*=\s*invites\.slice/)
  assert.match(component, /pagedInvites\.map/)
  assert.match(component, /第 \{clampedInvitePage\} \/ \{invitePageCount\} 页/)
  assert.match(component, />上一页</)
  assert.match(component, />下一页</)
  assert.match(css, /\.compute-gateway-manager__pagination/)
  assert.match(css, /\.compute-gateway-manager__pagination button/)
})

test('compute gateway account and channel lists are paginated', () => {
  const component = source('src/components/ComputeGatewayManager.tsx')

  assert.match(component, /const ACCOUNT_PAGE_SIZE\s*=\s*6/)
  assert.match(component, /const CHANNEL_PAGE_SIZE\s*=\s*6/)
  assert.match(component, /const \[accountPage,\s*setAccountPage\]/)
  assert.match(component, /const \[channelPage,\s*setChannelPage\]/)
  assert.match(component, /pagedAccounts\s*=\s*accounts\.slice/)
  assert.match(component, /pagedChannels\s*=\s*channels\.slice/)
  assert.match(component, /pagedAccounts\.map/)
  assert.match(component, /pagedChannels\.map/)
  assert.match(component, /第 \{clampedAccountPage\} \/ \{accountPageCount\} 页/)
  assert.match(component, /第 \{clampedChannelPage\} \/ \{channelPageCount\} 页/)
})

test('compute gateway destructive confirmations use WebView confirm fallback', () => {
  const component = source('src/components/ComputeGatewayManager.tsx')

  assert.doesNotMatch(component, /confirmDialog/)
  assert.match(component, /window\.confirm/)
})

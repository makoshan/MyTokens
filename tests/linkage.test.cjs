const assert = require('node:assert/strict')
const test = require('node:test')
const {
  getCredentialsLinkedToProject,
  resolveCredentialProjectName,
} = require('../.tmp-tests/src/utils/linkage.js')

function project(overrides = {}) {
  return {
    id: overrides.id ?? 'project-1',
    name: overrides.name ?? 'Default Project',
    path: overrides.path ?? '/workspace/default',
    credential_id: overrides.credential_id ?? null,
    created_at: overrides.created_at ?? '2026-01-01T00:00:00Z',
    updated_at: overrides.updated_at ?? '2026-01-01T00:00:00Z',
  }
}

function credential(overrides = {}) {
  return {
    id: overrides.id ?? 'cred-1',
    provider: overrides.provider ?? 'openai',
    source: overrides.source ?? null,
  }
}

test('resolveCredentialProjectName: 手动标签优先于路径与推导名称', () => {
  const projects = [
    project({ id: 'alpha', name: 'Alpha Project', path: '/workspace/alpha-repo' }),
    project({ id: 'beta', name: 'Beta Project', path: '/workspace/beta' }),
  ]
  const cred = credential({
    id: 'cred-manual',
    source: '/workspace/beta/src/index.ts',
  })
  const labels = { 'cred-manual': ' alpha-repo ' }

  const resolved = resolveCredentialProjectName(cred, labels, projects)
  assert.equal(resolved, 'Alpha Project')
})

test('resolveCredentialProjectName: 路径匹配优先于项目名推导', () => {
  const projects = [project({ id: 'rocket', name: 'Rocket', path: '/workspace/rocket' })]
  const cred = credential({
    id: 'cred-path',
    source: '/workspace/rocket/src/main.ts',
  })

  const resolved = resolveCredentialProjectName(cred, {}, projects)
  assert.equal(resolved, 'Rocket')
})

test('resolveCredentialProjectName: 未命中手动标签和路径时回退到项目名推导', () => {
  const projects = [project({ id: 'orion', name: 'Orion Project', path: '/repos/orion-app' })]
  const cred = credential({
    id: 'cred-derived',
    source: 'orion-app/src/index.ts',
  })

  const resolved = resolveCredentialProjectName(cred, {}, projects)
  assert.equal(resolved, 'Orion Project')
})

test('getCredentialsLinkedToProject: 基于同一优先级规则返回关联密钥', () => {
  const projects = [
    project({ id: 'alpha', name: 'Alpha Project', path: '/workspace/alpha-repo' }),
    project({ id: 'beta', name: 'Beta Project', path: '/workspace/beta' }),
  ]
  const target = projects[0]

  const credentials = [
    credential({
      id: 'manual-hit',
      source: '/workspace/beta/src/file.ts',
    }),
    credential({
      id: 'path-hit',
      source: '/workspace/alpha-repo/server/app.ts',
    }),
    credential({
      id: 'derived-hit',
      source: 'alpha-repo/scripts/run.ts',
    }),
    credential({
      id: 'miss',
      source: '/workspace/other/file.ts',
    }),
  ]
  const labels = { 'manual-hit': 'alpha-repo' }

  const linked = getCredentialsLinkedToProject(target, credentials, labels, projects)
  assert.deepEqual(
    linked.map((item) => item.id).sort(),
    ['derived-hit', 'manual-hit', 'path-hit']
  )
})

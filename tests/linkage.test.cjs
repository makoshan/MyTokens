const assert = require('node:assert/strict')
const test = require('node:test')
const {
  getCredentialsLinkedToProject,
  resolveCredentialProjectName,
  UNMATCHED_PROJECT_NAME,
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

test('resolveCredentialProjectName: 手动标签未命中时继续走路径匹配', () => {
  const projects = [
    project({ id: 'alpha', name: 'Alpha Project', path: '/workspace/alpha-repo' }),
    project({ id: 'beta', name: 'Beta Project', path: '/workspace/beta' }),
  ]
  const cred = credential({
    id: 'cred-manual-miss',
    source: '/workspace/beta/src/index.ts',
  })
  const labels = { 'cred-manual-miss': 'unknown-project' }

  const resolved = resolveCredentialProjectName(cred, labels, projects)
  assert.equal(resolved, 'Beta Project')
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

test('resolveCredentialProjectName: 未命中项目管理中的项目时归入未匹配项目', () => {
  const projects = [project({ id: 'alpha', name: 'Alpha Project', path: '/workspace/alpha-repo' })]
  const cred = credential({
    id: 'cred-miss',
    source: '/workspace/other/src/index.ts',
  })
  const labels = { 'cred-miss': 'custom-label' }

  const resolved = resolveCredentialProjectName(cred, labels, projects)
  assert.equal(resolved, UNMATCHED_PROJECT_NAME)
})

test('resolveCredentialProjectName: source 为多级路径时优先命中后段项目目录名', () => {
  const projects = [project({ id: 'mykey', name: 'mykey', path: '/Users/thursday/go/play/mykey' })]
  const cred = credential({
    id: 'cred-nested-source',
    source: 'play/mykey/.env.local',
  })

  const resolved = resolveCredentialProjectName(cred, {}, projects)
  assert.equal(resolved, 'mykey')
})

test('resolveCredentialProjectName: 手动标签写完整路径时可关联到项目', () => {
  const projects = [project({ id: 'mykey', name: 'mykey', path: '/Users/thursday/go/play/mykey' })]
  const cred = credential({
    id: 'cred-manual-path',
    source: '/tmp/other/.env',
  })
  const labels = { 'cred-manual-path': '/Users/thursday/go/play/mykey' }

  const resolved = resolveCredentialProjectName(cred, labels, projects)
  assert.equal(resolved, 'mykey')
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

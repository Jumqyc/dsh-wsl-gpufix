/**
 * Offline unit tests for gpu-device-grant.mjs.
 *
 * Run:  node --test
 *
 * Hermetic: no test requires a GPU, /dev/dxg, or a real sandbox. The fake
 * provider mirrors @deepseek-ai/dsh-sandbox-local's confine() shape (grant
 * flags, `--` separator, ConfinedArgv fields) closely enough to check where
 * the overlay inserts its grants and that it is fully reversible.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

import plugin, { DEFAULTS } from './gpu-device-grant.mjs'

const LANDLOCK = '/opt/dsh/landlock-run'

function makeSandbox({ program = LANDLOCK } = {}) {
  class FakeProvider {
    confine(argv, policy) {
      const grants = ['--ro', '/', '--rw', '/dev/null']
      if (policy.mode === 'workspace-write') {
        grants.push('--rw', '/tmp', '--rw', policy.workspaceRoot)
      }
      return {
        argv: [program, ...grants, '--', ...argv],
        enforcement: 'full',
        denialSignatures: ['permission denied'],
        runnerFailureRules: [],
      }
    }
  }
  return new FakeProvider()
}

function makeCtx(sandbox) {
  const logs = { info: [], warn: [] }
  const disposers = []
  return {
    sandbox,
    logger: {
      info: (message) => logs.info.push(String(message)),
      warn: (message) => logs.warn.push(String(message)),
    },
    effect(callback) {
      disposers.push(callback())
    },
    logs,
    disposeAll() {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

const POLICY_WRITE = { mode: 'workspace-write', workspaceRoot: '/workspace' }

test('defaults constant: /dev/dxg and /proc, workspace-write only', () => {
  assert.deepEqual(DEFAULTS, { readWrite: ['/dev/dxg', '/proc'], modes: ['workspace-write'] })
})

test('defaults at runtime: every default path that exists is granted', () => {
  const sandbox = makeSandbox()
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, {})

  const confined = sandbox.confine(['bash', '-c', 'true'], POLICY_WRITE)
  const grants = confined.argv.slice(0, confined.argv.indexOf('--'))
  const present = DEFAULTS.readWrite.filter((path) => existsSync(path))
  for (const path of present) assert.ok(grants.includes(path), `expected ${path} to be granted`)
  // A CI host without /dev/dxg still exercises the seam through /proc.
  assert.ok(present.length > 0)
})

test('workspace-write: inserts --rw before the separator, keeps the rest intact', () => {
  const sandbox = makeSandbox()
  const original = sandbox.confine
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, { readWrite: ['/dev/null'], modes: ['workspace-write'] })

  const confined = sandbox.confine(['bash', '-c', 'true'], POLICY_WRITE)
  const separator = confined.argv.indexOf('--')
  assert.deepEqual(confined.argv.slice(separator - 2, separator), ['--rw', '/dev/null'])
  assert.deepEqual(confined.argv.slice(separator + 1), ['bash', '-c', 'true'])
  assert.equal(confined.argv[0], LANDLOCK)
  assert.equal(confined.enforcement, 'full')
  assert.notEqual(sandbox.confine, original)
})

test('read-only: no grant is added', () => {
  const sandbox = makeSandbox()
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, { readWrite: ['/dev/null'], modes: ['workspace-write'] })

  const confined = sandbox.confine(['bash', '-c', 'true'], { mode: 'read-only', workspaceRoot: '/workspace' })
  assert.equal(confined.argv.filter((arg) => arg === '/dev/null').length, 1)
  assert.deepEqual(confined.argv.slice(confined.argv.indexOf('--') + 1), ['bash', '-c', 'true'])
})

test('danger-full-access: no grant is added', () => {
  const sandbox = makeSandbox()
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, { readWrite: ['/dev/null'], modes: ['workspace-write'] })

  const confined = sandbox.confine(['bash', '-c', 'true'], { mode: 'danger-full-access', workspaceRoot: '/workspace' })
  assert.equal(confined.argv.filter((arg) => arg === '/dev/null').length, 1)
})

test('custom modes: read-only can be opted in', () => {
  const sandbox = makeSandbox()
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, { readWrite: ['/dev/null'], modes: ['read-only'] })

  const confined = sandbox.confine(['bash', '-c', 'true'], { mode: 'read-only', workspaceRoot: '/workspace' })
  const separator = confined.argv.indexOf('--')
  assert.deepEqual(confined.argv.slice(separator - 2, separator), ['--rw', '/dev/null'])
})

test('missing path: skipped so the launcher never fails closed on it', () => {
  const sandbox = makeSandbox()
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, { readWrite: ['/definitely/not/here'], modes: ['workspace-write'] })

  const confined = sandbox.confine(['bash', '-c', 'true'], POLICY_WRITE)
  assert.equal(confined.argv.includes('/definitely/not/here'), false)
  assert.equal(confined.argv.filter((arg) => arg === '--rw').length, 3)
  assert.equal(ctx.logs.warn.length, 1)
  assert.match(ctx.logs.warn[0], /not present at mount/)
})

test('foreign runner: no grant, warning logged once', () => {
  const sandbox = makeSandbox({ program: 'bwrap' })
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, { readWrite: ['/dev/null'], modes: ['workspace-write'] })

  for (let i = 0; i < 3; i += 1) {
    const confined = sandbox.confine(['bash', '-c', 'true'], POLICY_WRITE)
    assert.equal(confined.argv.filter((arg) => arg === '/dev/null').length, 1)
  }
  assert.equal(ctx.logs.warn.length, 1)
  assert.match(ctx.logs.warn[0], /not the Landlock launcher/)
})

test('unloading restores the original confine exactly', () => {
  const sandbox = makeSandbox()
  const original = sandbox.confine
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, { readWrite: ['/dev/null'], modes: ['workspace-write'] })
  assert.notEqual(sandbox.confine, original)

  ctx.disposeAll()
  assert.equal(sandbox.confine, original)
  const confined = sandbox.confine(['bash', '-c', 'true'], POLICY_WRITE)
  assert.equal(confined.argv.filter((arg) => arg === '/dev/null').length, 1)
})

test('invalid config fails loud instead of silently not granting', () => {
  const ctx = makeCtx(makeSandbox())
  assert.throws(() => plugin.apply(ctx, { readWrite: 'nope' }), /config\.readWrite/)
  assert.throws(() => plugin.apply(ctx, { modes: ['nonsense'] }), /unknown sandbox mode/)
})

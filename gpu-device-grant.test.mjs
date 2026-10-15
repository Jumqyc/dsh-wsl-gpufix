/**
 * Offline unit tests for gpu-device-grant.mjs.
 *
 * Run:  node --test
 *
 * Hermetic: no test requires a GPU, /dev/dxg, or a real sandbox. The fake
 * provider mirrors @deepseek-ai/dsh-sandbox-local's confine() shape (grant
 * flags, `--` separator, ConfinedArgv fields) closely enough to check where
 * the overlay inserts its grants and that it is fully reversible.
 *
 * Both host shapes are covered: synchronous confine (dsh < 0.1.3) and the
 * async one (dsh >= 0.1.3, `Promise<ConfinedArgv>` plus a `signal` argument).
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

import plugin, { DEFAULTS } from './gpu-device-grant.mjs'

const LANDLOCK = '/opt/dsh/landlock-run'
const BWRAP = 'bwrap'
const OTHER_RUNNER = '/opt/dsh/windows-acl-run'

/**
 * Mirrors @deepseek-ai/dsh-sandbox-local's bwrapProfileArgs() exactly, including
 * the `--dev /dev` that creates the fresh minimal devtmpfs. The placement of
 * `--dev` is what the bwrap branch has to anchor to, so the fake profile must
 * keep it.
 */
function bwrapProfile(policy) {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') args.push('--tmpfs', '/tmp', '--bind', policy.workspaceRoot, policy.workspaceRoot)
  return args
}

function makeSandbox({ runner = LANDLOCK, isAsync = false, signals, profile } = {}) {
  const isBwrap = runner === BWRAP || runner.endsWith(`/${BWRAP}`)
  class FakeProvider {
    confine(argv, policy, signal) {
      signals?.push(signal)
      const head = profile ?? (isBwrap ? [runner, ...bwrapProfile(policy)] : [runner, ...landlockGrants(policy)])
      const confined = {
        argv: [...head, '--', ...argv],
        enforcement: 'full',
        denialSignatures: ['permission denied'],
        runnerFailureRules: [],
      }
      // dsh >= 0.1.3 declares confine async and resolves to the ConfinedArgv.
      return isAsync ? Promise.resolve(confined) : confined
    }
  }
  return new FakeProvider()
}

function landlockGrants(policy) {
  const grants = ['--ro', '/', '--rw', '/dev/null']
  if (policy.mode === 'workspace-write') {
    grants.push('--rw', '/tmp', '--rw', policy.workspaceRoot)
  }
  return grants
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

test('defaults constant: /dev/dxg and /proc for Landlock, /dev/dxg for bwrap', () => {
  assert.deepEqual(DEFAULTS, {
    readWrite: ['/dev/dxg', '/proc'],
    deviceBinds: ['/dev/dxg'],
    modes: ['workspace-write'],
  })
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

test('unsupported runner: no grant, warning logged once', () => {
  const sandbox = makeSandbox({ runner: OTHER_RUNNER })
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, { readWrite: ['/dev/null'], modes: ['workspace-write'] })

  for (let i = 0; i < 3; i += 1) {
    const confined = sandbox.confine(['bash', '-c', 'true'], POLICY_WRITE)
    assert.equal(confined.argv.filter((arg) => arg === '/dev/null').length, 1)
  }
  assert.equal(ctx.logs.warn.length, 1)
  assert.match(ctx.logs.warn[0], /neither the Landlock launcher nor bwrap/)
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

test('sync host (dsh < 0.1.3): the wrapper stays synchronous', () => {
  const sandbox = makeSandbox()
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, { readWrite: ['/dev/null'], modes: ['workspace-write'] })

  const confined = sandbox.confine(['bash', '-c', 'true'], POLICY_WRITE)
  assert.equal(typeof confined.then, 'undefined')
  assert.equal(confined.argv[0], LANDLOCK)
  assert.ok(confined.argv.includes('/dev/null'))
})

test('async host (dsh >= 0.1.3): grants land on the resolved ConfinedArgv, not on the promise', async () => {
  const sandbox = makeSandbox({ isAsync: true })
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, { readWrite: ['/dev/null'], modes: ['workspace-write'] })

  const pending = sandbox.confine(['bash', '-c', 'true'], POLICY_WRITE)
  assert.equal(typeof pending.then, 'function')
  const confined = await pending
  const separator = confined.argv.indexOf('--')
  assert.deepEqual(confined.argv.slice(separator - 2, separator), ['--rw', '/dev/null'])
  assert.deepEqual(confined.argv.slice(separator + 1), ['bash', '-c', 'true'])
  assert.equal(confined.argv[0], LANDLOCK)
  assert.equal(confined.enforcement, 'full')
})

test('async host: read-only passes through unchanged', async () => {
  const sandbox = makeSandbox({ isAsync: true })
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, { readWrite: ['/dev/null'], modes: ['workspace-write'] })

  const confined = await sandbox.confine(['bash', '-c', 'true'], { mode: 'read-only', workspaceRoot: '/workspace' })
  assert.equal(confined.argv.filter((arg) => arg === '/dev/null').length, 1)
  assert.deepEqual(confined.argv.slice(confined.argv.indexOf('--') + 1), ['bash', '-c', 'true'])
})

test('async host: the signal argument is forwarded to the original confine', async () => {
  const signals = []
  const sandbox = makeSandbox({ isAsync: true, signals })
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, { readWrite: ['/dev/null'], modes: ['workspace-write'] })

  const controller = new AbortController()
  await sandbox.confine(['bash', '-c', 'true'], POLICY_WRITE, controller.signal)
  assert.equal(signals.length, 1)
  assert.equal(signals[0], controller.signal)
})

test('async host: unsupported runner still warns once and adds nothing', async () => {
  const sandbox = makeSandbox({ runner: OTHER_RUNNER, isAsync: true })
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, { readWrite: ['/dev/null'], modes: ['workspace-write'] })

  for (let i = 0; i < 3; i += 1) {
    const confined = await sandbox.confine(['bash', '-c', 'true'], POLICY_WRITE)
    assert.equal(confined.argv.filter((arg) => arg === '/dev/null').length, 1)
  }
  assert.equal(ctx.logs.warn.length, 1)
  assert.match(ctx.logs.warn[0], /neither the Landlock launcher nor bwrap/)
})

// --- bwrap rung --------------------------------------------------------------
//
// Both path lists are pinned to /dev/null, which exists on every Linux host, so
// these cases never depend on /dev/dxg and emit no mount-time "not present"
// warning. That keeps the warn-count assertions deterministic on CI.

const BWRAP_CONFIG = { readWrite: ['/dev/null'], deviceBinds: ['/dev/null'], modes: ['workspace-write'] }

test('bwrap: the device bind lands immediately after --dev /dev, never before it', () => {
  const sandbox = makeSandbox({ runner: BWRAP })
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, BWRAP_CONFIG)

  const confined = sandbox.confine(['bash', '-c', 'true'], POLICY_WRITE)
  const dev = confined.argv.indexOf('--dev')
  assert.deepEqual(
    confined.argv.slice(dev, dev + 5),
    ['--dev', '/dev', '--dev-bind', '/dev/null', '/dev/null'],
  )
})

test('bwrap: readWrite is a Landlock-only knob — no --rw is ever injected', () => {
  const sandbox = makeSandbox({ runner: BWRAP })
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, { readWrite: ['/dev/null', '/proc'], deviceBinds: ['/dev/null'], modes: ['workspace-write'] })

  const confined = sandbox.confine(['bash', '-c', 'true'], POLICY_WRITE)
  const separator = confined.argv.indexOf('--')
  // bwrap rejects unknown options outright, so one stray --rw would break
  // every confined command — this is the regression that matters most. The
  // profile is exactly the vendor's, with the single bind inserted right after
  // `--dev /dev`; `--proc /proc` is left as the vendor built it.
  assert.deepEqual(confined.argv.slice(0, separator), [
    'bwrap',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--dev-bind', '/dev/null', '/dev/null',
    '--unshare-pid',
    '--proc', '/proc',
    '--die-with-parent',
    '--tmpfs', '/tmp',
    '--bind', POLICY_WRITE.workspaceRoot, POLICY_WRITE.workspaceRoot,
  ])
})

test('bwrap: bwrap reached through an absolute path is still recognised', () => {
  const sandbox = makeSandbox({ runner: '/usr/bin/bwrap' })
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, BWRAP_CONFIG)

  const confined = sandbox.confine(['bash', '-c', 'true'], POLICY_WRITE)
  assert.ok(confined.argv.includes('--dev-bind'))
})

test('bwrap: the wrapped command and the ConfinedArgv facts survive the edit', () => {
  const sandbox = makeSandbox({ runner: BWRAP })
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, BWRAP_CONFIG)

  const confined = sandbox.confine(['bash', '-c', 'true'], POLICY_WRITE)
  assert.deepEqual(confined.argv.slice(confined.argv.indexOf('--') + 1), ['bash', '-c', 'true'])
  assert.equal(confined.argv[0], BWRAP)
  assert.equal(confined.enforcement, 'full')
  assert.deepEqual(confined.denialSignatures, ['permission denied'])
  assert.deepEqual(confined.runnerFailureRules, [])
})

test('bwrap: a missing device is skipped so bwrap never fails the whole command', () => {
  const sandbox = makeSandbox({ runner: BWRAP })
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, { readWrite: ['/dev/null'], deviceBinds: ['/definitely/not/here'], modes: ['workspace-write'] })

  const confined = sandbox.confine(['bash', '-c', 'true'], POLICY_WRITE)
  assert.equal(confined.argv.includes('--dev-bind'), false)
  assert.equal(ctx.logs.warn.length, 1)
  assert.match(ctx.logs.warn[0], /not present at mount/)
})

test('bwrap: read-only mode leaves the profile untouched', () => {
  const sandbox = makeSandbox({ runner: BWRAP })
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, BWRAP_CONFIG)

  const confined = sandbox.confine(['bash', '-c', 'true'], { mode: 'read-only', workspaceRoot: '/workspace' })
  assert.equal(confined.argv.includes('--dev-bind'), false)
})

test('bwrap: a profile without --dev is refused once, rather than silently hidden', () => {
  // Without the devtmpfs flag there is no mount for the bind to survive, and
  // injecting it anyway would reproduce the original bug with no error at all.
  const profile = ['bwrap', '--ro-bind', '/', '/', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  const sandbox = makeSandbox({ runner: BWRAP, profile })
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, BWRAP_CONFIG)

  for (let i = 0; i < 3; i += 1) {
    const confined = sandbox.confine(['bash', '-c', 'true'], POLICY_WRITE)
    assert.equal(confined.argv.includes('--dev-bind'), false)
  }
  assert.equal(ctx.logs.warn.length, 1)
  assert.match(ctx.logs.warn[0], /no --dev <dest> before the separator/)
})

test('bwrap: unload restores the original confine exactly', () => {
  const sandbox = makeSandbox({ runner: BWRAP })
  const original = sandbox.confine
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, BWRAP_CONFIG)
  assert.notEqual(sandbox.confine, original)

  ctx.disposeAll()
  assert.equal(sandbox.confine, original)
  assert.equal(sandbox.confine(['bash', '-c', 'true'], POLICY_WRITE).argv.includes('--dev-bind'), false)
})

test('bwrap async host: the bind lands on the resolved ConfinedArgv', async () => {
  const sandbox = makeSandbox({ runner: BWRAP, isAsync: true })
  const ctx = makeCtx(sandbox)
  plugin.apply(ctx, BWRAP_CONFIG)

  const pending = sandbox.confine(['bash', '-c', 'true'], POLICY_WRITE)
  assert.equal(typeof pending.then, 'function')
  const confined = await pending
  const dev = confined.argv.indexOf('--dev')
  assert.deepEqual(
    confined.argv.slice(dev, dev + 5),
    ['--dev', '/dev', '--dev-bind', '/dev/null', '/dev/null'],
  )
  assert.deepEqual(confined.argv.slice(confined.argv.indexOf('--') + 1), ['bash', '-c', 'true'])
})

test('bwrap: an invalid deviceBinds list fails loud at mount', () => {
  const ctx = makeCtx(makeSandbox({ runner: BWRAP }))
  assert.throws(() => plugin.apply(ctx, { deviceBinds: 'nope' }), /config\.deviceBinds/)
  assert.throws(() => plugin.apply(ctx, { deviceBinds: [] }), /config\.deviceBinds/)
})

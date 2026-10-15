/**
 * Integration check for gpu-device-grant.mjs against a real dsh-sandbox-local.
 *
 * The unit tests (`node --test`) fake the provider so they stay hermetic; this
 * script loads the host's actual provider and asserts what the wrapper hands
 * back. It needs no GPU, no /dev/dxg and no sandbox — it only inspects the
 * argv — so it also runs inside an already-confined shell.
 *
 * Usage:
 *   node gpu-device-grant.integration.mjs
 *   DSH_SANDBOX_LOCAL=/path/to/dsh-sandbox-local/lib/index.js node gpu-device-grant.integration.mjs
 *
 * Exits 0 when no installation is found (nothing to check) and 1 on a real
 * mismatch, so it can gate a release.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PLUGIN = new URL('./gpu-device-grant.mjs', import.meta.url)

/** Candidate locations of dsh-sandbox-local's entry point. */
function candidates() {
  const binDir = dirname(process.execPath)
  const roots = [
    join(binDir, '..', 'lib', 'node_modules'),        // nvm and other standard prefixes
    join(binDir, '..', '..', 'lib', 'node_modules'),  // /usr/bin/node
    '/usr/local/lib/node_modules',
  ]
  return roots.flatMap((root) => [
    join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-sandbox-local', 'lib', 'index.js'),
    join(root, '@deepseek-ai', 'dsh-sandbox-local', 'lib', 'index.js'),
  ])
}

const entry = process.env.DSH_SANDBOX_LOCAL ?? candidates().find((path) => existsSync(path))
if (entry === undefined) {
  console.log('skip: no dsh-sandbox-local found; set DSH_SANDBOX_LOCAL to check the wrapper against a real host')
  process.exit(0)
}
console.log('sandbox package:', entry)

const mod = await import(entry)
const Provider = mod.LocalSandboxProvider ?? mod.default
if (typeof Provider !== 'function') throw new Error(`LocalSandboxProvider is not exported by ${entry}`)
const plugin = (await import(PLUGIN)).default

const POLICY = { mode: 'workspace-write', workspaceRoot: process.cwd() }
const ARGV = ['bash', '-c', 'true']
let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

/** A real provider: the constructor needs a live cordis context, so build off the real prototype.
 * The chain is pinned so the provider resolves its own runner and profile without probing. */
function makeProvider(chain = ['landlock']) {
  const sandbox = Object.create(Provider.prototype)
  sandbox.internals = { chain }
  sandbox.runnerCommand = undefined
  sandbox.configuredRunnerFailureSignatures = []
  sandbox.probeTimeoutMs = 5000
  return sandbox
}

/** Mount the plugin on one provider and return its logs plus an exact unmount. */
function mount(sandbox, config = {}) {
  const disposers = []
  const logs = []
  plugin.apply({
    sandbox,
    logger: { info: (m) => logs.push(`info: ${m}`), warn: (m) => logs.push(`warn: ${m}`) },
    effect: (cb) => disposers.push(cb()),
  }, config)
  return { logs, unload: () => { for (const dispose of disposers.reverse()) dispose() } }
}

// 1. the real host is async, and grants nothing on its own.
{
  const sandbox = makeProvider()
  const pending = sandbox.confine(ARGV, POLICY)
  check('unpatched confine returns a thenable', typeof pending.then === 'function', `got ${typeof pending.then}`)
  const confined = await pending
  check('unpatched argv does not grant /dev/dxg', !confined.argv.includes('/dev/dxg'))
  check('launcher is landlock-run', String(confined.argv[0]).endsWith('landlock-run'), String(confined.argv[0]))
}

// 2. the wrapper injects the grants on the resolved ConfinedArgv and preserves the rest.
{
  const sandbox = makeProvider()
  const { logs } = mount(sandbox)
  check('mount logs the grant', logs.some((line) => line.includes('/dev/dxg')), logs.join(' | '))
  const pending = sandbox.confine(ARGV, POLICY)
  check('patched confine still returns a thenable', typeof pending.then === 'function')
  const confined = await pending
  const separator = confined.argv.indexOf('--')
  const before = JSON.stringify(confined.argv.slice(separator - 4, separator))
  check('grants sit immediately before the separator',
    before === JSON.stringify(['--rw', '/dev/dxg', '--rw', '/proc']), before)
  check('the command after the separator is untouched',
    JSON.stringify(confined.argv.slice(separator + 1)) === JSON.stringify(ARGV))
  check('enforcement survives the patch', confined.enforcement === 'full', String(confined.enforcement))
}

// 3. read-only stays untouched and unloading is exact.
{
  const sandbox = makeProvider()
  const original = sandbox.confine
  const { unload } = mount(sandbox)
  check('mount replaces confine', sandbox.confine !== original)
  const confined = await sandbox.confine(ARGV, { mode: 'read-only', workspaceRoot: POLICY.workspaceRoot })
  check('read-only gains no grant', !confined.argv.includes('/dev/dxg'))
  unload()
  check('unload restores the original confine', sandbox.confine === original)
}

// 4. the bwrap rung: the real bwrap profile, patched right after `--dev /dev`.
// Pinned to /dev/null so this check runs on a host with no GPU; the real
// /dev/dxg case is covered by step 5 when the device is actually present.
{
  const sandbox = makeProvider(['bwrap'])
  const { logs } = mount(sandbox, { deviceBinds: ['/dev/null'] })
  check('mount logs the bwrap bind', logs.some((line) => line.includes('--dev-bind')), logs.join(' | '))
  const confined = await sandbox.confine(ARGV, POLICY)
  check('bwrap is the selected runner', confined.argv[0] === 'bwrap', String(confined.argv[0]))
  const dev = confined.argv.indexOf('--dev')
  const before = JSON.stringify(confined.argv.slice(dev, dev + 5))
  check('the bind sits immediately after --dev /dev',
    before === JSON.stringify(['--dev', '/dev', '--dev-bind', '/dev/null', '/dev/null']), before)
  check('no --rw leaks into a bwrap profile', !confined.argv.includes('--rw'))
  check('the command after the separator is untouched',
    JSON.stringify(confined.argv.slice(confined.argv.indexOf('--') + 1)) === JSON.stringify(ARGV))
  check('enforcement survives the bwrap patch', confined.enforcement === 'full', String(confined.enforcement))
}

// 5. the default device, on a host that actually has it.
if (existsSync('/dev/dxg')) {
  const sandbox = makeProvider(['bwrap'])
  mount(sandbox)
  const confined = await sandbox.confine(ARGV, POLICY)
  const dev = confined.argv.indexOf('--dev')
  const before = JSON.stringify(confined.argv.slice(dev, dev + 5))
  check('the default config binds /dev/dxg on bwrap',
    before === JSON.stringify(['--dev', '/dev', '--dev-bind', '/dev/dxg', '/dev/dxg']), before)
} else {
  console.log('skip: /dev/dxg absent; the default bwrap device bind is not checked')
}

console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)

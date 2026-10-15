/**
 * gpu-device-grant — host-plane Cordis plugin that makes the WSL2 GPU
 * reachable inside the DSH local sandbox, on whichever runner that sandbox
 * selects: the Landlock launcher or bubblewrap.
 *
 * Why this exists
 * ---------------
 * `@deepseek-ai/dsh-sandbox-local` hard-codes both runners' profiles and
 * neither exposes `/dev/dxg` usefully.
 *
 * On the Landlock rung the profile is a grant list — `/dev/null` always, plus
 * `/tmp` and the workspace root under `workspace-write` — so two extra grants
 * are needed for the GPU:
 *
 * 1. `/dev/dxg` — the WSL GPU device. Without write access a confined process
 *    can open it read-only only, so CUDA/NVML report "no device" (`cuInit`
 *    -> CUDA_ERROR_NO_DEVICE / 304, `nvidia-smi` -> "GPU access blocked by
 *    the operating system").
 * 2. `/proc` — libcuda writes the thread name to
 *    `/proc/self/task/<tid>/comm` during `cuInit` and treats a denied write
 *    as a fatal OS error (CUDA_ERROR_OPERATING_SYSTEM, 304), even though the
 *    device itself is reachable. The rule must be on the procfs mount root:
 *    the launcher resolves grant paths in its own process, so a rule on
 *    `/proc/self` would cover only the launcher/`bash` pid and not the
 *    descendant `python`/`nvcc`/torch process that actually calls CUDA.
 *    (DAC still limits writes under /proc to the process's own entries and
 *    root-owned sysctls, exactly as for an unconfined process.)
 *
 * The launcher already supports file-level grants (`--rw /dev/null` works the
 * same way), so on that rung the fix is to add these grants to the profile.
 *
 * On the bwrap rung a grant is meaningless, because the profile mounts
 * `--dev /dev` — a fresh minimal devtmpfs in which `/dev/dxg` does not exist
 * at all. The device has to be mounted in with `--dev-bind /dev/dxg /dev/dxg`,
 * and that bind must land AFTER `--dev <dest>` in the argv: `--dev` mounts the
 * fresh devtmpfs over `/dev`, so a bind placed before it is covered by that
 * mount and `/dev/dxg` disappears again — silently, with no bwrap error and no
 * nonzero exit. `/proc` needs nothing on this rung: the profile's own
 * `--proc /proc` mounts a fresh procfs in which the confined process can
 * already write its own task `comm`.
 *
 * This plugin makes both profile changes from the outside, on the public
 * `ctx.sandbox.confine()` seam, so no vendor file is edited and the change
 * survives harness upgrades.
 *
 * What it does
 * ------------
 * Wraps `LocalSandboxProvider.prototype.confine` while the row is mounted:
 * calls the original, then inspects the runner the host actually selected and,
 * only for the configured sandbox modes, edits that runner's own dialect:
 *
 *   Landlock launcher -> insert `--rw <path>` grants for `readWrite`
 *   bwrap             -> insert `--dev-bind <path> <path>` for `deviceBinds`,
 *                        anchored immediately after `--dev <dest>`
 *
 * A runner that is neither is left untouched and warned about once. The
 * original method is restored when the row unloads (`ctx.effect`), so the
 * patch is fully reversible.
 *
 * The runner is read off the RESOLVED `ConfinedArgv.argv[0]`, never off the
 * argv the caller passed: `confine(argv, policy)` receives the caller's own
 * command (`['bash', '-c', …]`) and picks the runner internally, so the
 * caller's argv never names it.
 *
 * `confine` is `async` since dsh 0.1.3 (`Promise<ConfinedArgv>`, plus a third
 * `signal` argument) and synchronous before that, so the wrapper mirrors the
 * shape it is handed: a thenable is awaited before the grants are injected, a
 * plain object is patched in place. Assuming the synchronous shape is what
 * broke every confined command on dsh 0.1.7-rc.1 with
 * `TypeError: Cannot read properties of undefined (reading '0')`.
 *
 * Missing paths are skipped at call time (the Landlock launcher fails closed
 * on an unopenable grant root, and bwrap fails the whole command on an
 * unbindable source, so naming a device that is not present would break every
 * sandboxed command). `/dev/dxg` appearing later is picked up on the next call
 * with no restart.
 *
 * Mounting it (host composition)
 * ------------------------------
 * A patch layer, e.g. `$DSH_HOME/cordis.patch.yml`:
 *
 *   - insert:
 *       - id: gpu-device-grant
 *         name: ./plugins/gpu-device-grant.mjs
 *         config:
 *           readWrite: ['/dev/dxg', '/proc']
 *           deviceBinds: ['/dev/dxg']
 *           modes: ['workspace-write']
 *
 * Config (all optional)
 * ---------------------
 *   readWrite    string[]  absolute paths granted read+write — Landlock rung
 *                          only (default ['/dev/dxg', '/proc'])
 *   deviceBinds  string[]  absolute device nodes mounted in with --dev-bind —
 *                          bwrap rung only (default ['/dev/dxg'])
 *   modes        string[]  sandbox modes the grant applies to
 *                          (default ['workspace-write']; add 'read-only' to
 *                          allow GPU use in read-only sessions too)
 *
 * The two path lists are not interchangeable and are deliberately separate:
 * bwrap cannot express Landlock's `--rw /proc` (binding the host procfs would
 * defeat the profile's own `--proc /proc`), and Landlock cannot express a
 * device-node mount. Each rung reads only the list it can honour.
 *
 * Caveats
 * -------
 * - `danger-full-access` never reaches `confine()`, so it needs nothing.
 * - Editing this file needs a DSH restart: the loader caches the imported
 *   module, and a patch-file reload reuses the cached callback.
 */

import { existsSync } from 'node:fs'

const DEFAULTS = {
  readWrite: ['/dev/dxg', '/proc'],
  deviceBinds: ['/dev/dxg'],
  modes: ['workspace-write'],
}

const KNOWN_MODES = ['read-only', 'workspace-write', 'danger-full-access']
const LANDLOCK_RUNNER_SUFFIX = 'landlock-run'
const BWRAP_RUNNER = 'bwrap'
const BWRAP_DEV_FLAG = '--dev'

/** Read one optional string-array config field, or its default. */
function readStringArray(config, key, fallback) {
  const value = config[key]
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`gpu-device-grant: config.${key} must be a non-empty array of non-empty strings`)
  }
  return [...value]
}

/** Last path segment of a runner program, so `bwrap` and `/usr/bin/bwrap` both match. */
function runnerName(program) {
  return program.slice(program.lastIndexOf('/') + 1)
}

const plugin = {
  name: 'gpu-device-grant',
  inject: ['sandbox'],
  apply(ctx, config = {}) {
    const readWrite = readStringArray(config, 'readWrite', DEFAULTS.readWrite)
    const deviceBinds = readStringArray(config, 'deviceBinds', DEFAULTS.deviceBinds)
    const modes = readStringArray(config, 'modes', DEFAULTS.modes)
    for (const mode of modes) {
      if (!KNOWN_MODES.includes(mode)) {
        throw new Error(`gpu-device-grant: config.modes contains unknown sandbox mode ${JSON.stringify(mode)}`)
      }
    }
    const activeModes = new Set(modes)
    const missingAtMount = [...new Set([...readWrite, ...deviceBinds])].filter((path) => !existsSync(path))
    if (missingAtMount.length > 0) {
      ctx.logger.warn(`gpu-device-grant: ${missingAtMount.join(', ')} not present at mount; it will be granted as soon as it exists`)
    }
    const sandbox = ctx.sandbox
    const proto = Object.getPrototypeOf(sandbox)
    const original = proto.confine
    if (typeof original !== 'function') {
      ctx.logger.warn('gpu-device-grant: ctx.sandbox.confine is not a function; no grant installed')
      return
    }
    const warned = new Set()
    const warnOnce = (key, message) => {
      if (warned.has(key)) return
      warned.add(key)
      ctx.logger.warn(message)
    }
    // Edits are applied to the *resolved* ConfinedArgv, so one implementation
    // serves both the synchronous and the async host. The runner is read off
    // that result, never off the caller's argv: confine() receives the caller's
    // own command and picks the runner internally.
    const injectGrants = (confined, policy) => {
      if (policy === undefined || !activeModes.has(policy.mode)) return confined
      const argv = confined.argv
      const program = argv[0] ?? ''
      const separator = argv.indexOf('--')
      if (separator < 0) return confined

      if (runnerName(program) === BWRAP_RUNNER) {
        const binds = deviceBinds.filter((path) => existsSync(path)).flatMap((path) => ['--dev-bind', path, path])
        if (binds.length === 0) return confined
        // `--dev <dest>` mounts a fresh minimal devtmpfs over /dev, so the bind
        // has to land after it. Anywhere earlier it is covered by that mount and
        // the device silently disappears again — no bwrap error, no nonzero exit.
        const dev = argv.indexOf(BWRAP_DEV_FLAG)
        if (dev < 0 || dev + 1 >= separator) {
          warnOnce('bwrap-profile', `gpu-device-grant: bwrap profile has no ${BWRAP_DEV_FLAG} <dest> before the separator; leaving ${deviceBinds.join(', ')} alone rather than placing them where that devtmpfs would hide them`)
          return confined
        }
        return {
          ...confined,
          argv: [
            ...argv.slice(0, dev + 2),
            ...binds,
            ...argv.slice(dev + 2),
          ],
        }
      }

      if (!program.endsWith(LANDLOCK_RUNNER_SUFFIX)) {
        warnOnce('runner', `gpu-device-grant: sandbox runner ${JSON.stringify(program)} is neither the Landlock launcher nor bwrap; the ${readWrite.join(', ')} grant is not applied`)
        return confined
      }
      const grants = readWrite.filter((path) => existsSync(path)).flatMap((path) => ['--rw', path])
      if (grants.length === 0) return confined
      return {
        ...confined,
        argv: [
          ...argv.slice(0, separator),
          ...grants,
          ...argv.slice(separator),
        ],
      }
    }
    // `confine` is `async` since dsh 0.1.3 — `Promise<ConfinedArgv>` plus a third
    // `signal` argument — and synchronous before that. Mirror whatever the host
    // returns instead of assuming: taking `.argv` off the promise is exactly what
    // broke every confined command on dsh 0.1.7-rc.1.
    const patched = function confine(argv, policy, signal) {
      const confined = original.call(this, argv, policy, signal)
      return confined !== null && typeof confined?.then === 'function'
        ? confined.then((resolved) => injectGrants(resolved, policy))
        : injectGrants(confined, policy)
    }
    ctx.effect(() => {
      proto.confine = patched
      ctx.logger.info(`gpu-device-grant: granting rw on ${readWrite.join(', ')} (Landlock) and --dev-bind on ${deviceBinds.join(', ')} (bwrap) to sandbox mode(s) ${modes.join(', ')}`)
      return () => {
        if (proto.confine === patched) proto.confine = original
      }
    })
  },
}

export default plugin
export { DEFAULTS }

/**
 * gpu-device-grant — host-plane Cordis plugin that widens the DSH local
 * sandbox's Landlock grant set by exactly the device paths it names.
 *
 * Why this exists
 * ---------------
 * `@deepseek-ai/dsh-sandbox-local` builds the Landlock profile from a
 * hard-coded list: `/dev/null` always, plus `/tmp` and the workspace root
 * under `workspace-write`. Two extra grants are needed for the GPU:
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
 * same way), so the fix is to add these grants to the profile. This plugin
 * does that from the outside, on the public `ctx.sandbox.confine()` seam, so
 * no vendor file is edited and the change survives harness upgrades.
 *
 * What it does
 * ------------
 * Wraps `LocalSandboxProvider.prototype.confine` while the row is mounted:
 * calls the original, then — only for the configured sandbox modes and only
 * when the selected runner is the Landlock launcher — inserts extra
 * `--rw <path>` grants just before the `--` argv separator. The original
 * method is restored when the row unloads (`ctx.effect`), so the patch is
 * fully reversible.
 *
 * Missing paths are skipped at call time (the Landlock launcher fails closed
 * on an unopenable grant root, so granting a device that is not present would
 * break every sandboxed command). `/dev/dxg` appearing later is picked up on
 * the next call with no restart.
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
 *           modes: ['workspace-write']
 *
 * Config (all optional)
 * ---------------------
 *   readWrite  string[]  absolute paths granted read+write
 *                        (default ['/dev/dxg', '/proc'])
 *   modes      string[]  sandbox modes the grant applies to
 *                        (default ['workspace-write']; add 'read-only' to
 *                        allow GPU use in read-only sessions too)
 *
 * Caveats
 * -------
 * - Landlock-only: if bubblewrap becomes the selected runner, the grant is not
 *   applied (bwrap's `--dev /dev` mounts a fresh /dev without /dev/dxg anyway)
 *   and a warning is logged once.
 * - `danger-full-access` never reaches `confine()`, so it needs nothing.
 * - Editing this file needs a DSH restart: the loader caches the imported
 *   module, and a patch-file reload reuses the cached callback.
 */

import { existsSync } from 'node:fs'

const DEFAULTS = {
  readWrite: ['/dev/dxg', '/proc'],
  modes: ['workspace-write'],
}

const KNOWN_MODES = ['read-only', 'workspace-write', 'danger-full-access']
const LANDLOCK_RUNNER_SUFFIX = 'landlock-run'

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

const plugin = {
  name: 'gpu-device-grant',
  inject: ['sandbox'],
  apply(ctx, config = {}) {
    const readWrite = readStringArray(config, 'readWrite', DEFAULTS.readWrite)
    const modes = readStringArray(config, 'modes', DEFAULTS.modes)
    for (const mode of modes) {
      if (!KNOWN_MODES.includes(mode)) {
        throw new Error(`gpu-device-grant: config.modes contains unknown sandbox mode ${JSON.stringify(mode)}`)
      }
    }
    const activeModes = new Set(modes)
    const missingAtMount = readWrite.filter((path) => !existsSync(path))
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
    let warnedForeignRunner = false
    const patched = function confine(argv, policy) {
      const confined = original.call(this, argv, policy)
      if (policy === undefined || !activeModes.has(policy.mode)) return confined
      const program = confined.argv[0] ?? ''
      if (!program.endsWith(LANDLOCK_RUNNER_SUFFIX)) {
        if (!warnedForeignRunner) {
          warnedForeignRunner = true
          ctx.logger.warn(`gpu-device-grant: sandbox runner ${JSON.stringify(program)} is not the Landlock launcher; the ${readWrite.join(', ')} grant is not applied`)
        }
        return confined
      }
      const grants = readWrite.filter((path) => existsSync(path)).flatMap((path) => ['--rw', path])
      if (grants.length === 0) return confined
      const separator = confined.argv.indexOf('--')
      if (separator < 0) return confined
      return {
        ...confined,
        argv: [
          ...confined.argv.slice(0, separator),
          ...grants,
          ...confined.argv.slice(separator),
        ],
      }
    }
    ctx.effect(() => {
      proto.confine = patched
      ctx.logger.info(`gpu-device-grant: granting rw on ${readWrite.join(', ')} to sandbox mode(s) ${modes.join(', ')}`)
      return () => {
        if (proto.confine === patched) proto.confine = original
      }
    })
  },
}

export default plugin
export { DEFAULTS }

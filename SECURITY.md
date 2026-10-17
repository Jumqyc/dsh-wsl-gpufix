# Security policy

## What this plugin does

While its row is mounted, `gpu-device-grant` wraps the public
`ctx.sandbox.confine()` service method, reads the runner the host actually
selected off the resolved `ConfinedArgv`, and appends that runner's own options
for the configured paths and sandbox modes:

- Landlock launcher — `--rw <path>` for each `readWrite` path.
- bwrap — `--dev-bind <path> <path>` for each `deviceBinds` path, inserted
  immediately after `--dev <dest>`.

The original method is restored when the row unloads.

It is deliberately small and auditable: one file, no dependencies beyond
`node:fs`, no network access, no child processes, no `eval`, and no code
executed from configuration.

## What it does not do

- It does not disable Landlock or bubblewrap, or make the sandbox unconfined.
- It does not modify the approval policy or bypass approval prompts.
- It does not edit any file in the DSH installation or in shipped presets.
- It cannot grant anything the operator did not list in `readWrite`
  (Landlock) or `deviceBinds` (bwrap).
- It never widens `/dev` as a whole: bwrap gets one `--dev-bind` per configured
  device node, never `--dev-bind /dev /dev`, which would hand the sandbox every
  block, input and random device on the host and undo the minimal `/dev` that
  `--dev /dev` exists to provide.

## The risk you are accepting

The plugin widens the isolation boundary of the sandbox by exactly the paths you
list, for the modes in `modes`. Treat both lists as security-relevant
configuration:

- `/dev/dxg` is the WSL GPU device; granting it lets confined processes submit
  GPU work, which is the point of the plugin.
- `/proc` is broader than a single file, and is a **Landlock-only** entry. It is
  required because libcuda writes `/proc/self/task/<tid>/comm` during `cuInit`.
  DAC still limits writes under `/proc` to the process's own entries and
  root-owned sysctls, and the launcher keeps `no_new_privs` set, so this is not a
  privilege-escalation path — but it is more than a single-file grant.
- Any other path you add (for example `/dev`, `/run`, or `/`) inherits the same
  effect. Granting `/` is equivalent to removing the file sandbox, and adding it
  to `deviceBinds` would expose whole device trees.
- A `deviceBinds` entry is a writable device node inside the sandbox. Name
  individual nodes, not directories, and only nodes the workload needs.

If you only need NVML (`nvidia-smi`), use `readWrite: ['/dev/dxg']` on Landlock
(or just the default `deviceBinds` on bwrap). CUDA will then fail with error 304
on Landlock.

## Compatibility and failure mode

The plugin depends on `LocalSandboxProvider.prototype.confine`, the Landlock
launcher's `--rw` flag contract, and bwrap's `--dev /dev … --dev-bind …` profile
shape. If any of them changes, the row logs a warning and does nothing — it fails
soft, never open, and never runs unconfined.

## Reporting a vulnerability

Open a GitHub security advisory on this repository, or a regular issue if the
report contains no sensitive detail. Please include the DSH version, kernel,
and the effective `readWrite`/`modes` config.

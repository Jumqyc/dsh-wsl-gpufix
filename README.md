# dsh-wsl-gpufix

[![test](https://github.com/Jumqyc/dsh-wsl-gpufix/actions/workflows/test.yml/badge.svg)](https://github.com/Jumqyc/dsh-wsl-gpufix/actions/workflows/test.yml)

**Unofficial community plugin — not affiliated with or endorsed by DeepSeek.**

[English](README.md) | [简体中文](README.zh.md)

A Cordis host-composition plugin for [DSH](https://github.com/deepseek-ai) that
makes the WSL2 GPU device reachable inside the DSH local sandbox, so
`torch.cuda.is_available()` is `True` inside a normal (confined) agent `bash`
session — on **either** runner `dsh-sandbox-local` selects, the Landlock
launcher or bubblewrap.

```console
$ python -c "import os, torch; os.close(os.open('/dev/dxg', os.O_RDWR)); print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
True NVIDIA GeForce RTX 4060 Laptop GPU
```

Install in one command:

```sh
dsh plugin --profile <profile> add github:Jumqyc/dsh-wsl-gpufix
```

---

## The problem

`@deepseek-ai/dsh-sandbox-local` hard-codes both runners' profiles, and neither
exposes `/dev/dxg` usefully.

**On the Landlock rung** the profile is a grant list — `/dev/null` always, plus
`/tmp` and the workspace root under `workspace-write`. Nothing else is writable,
and there is no config field for extra paths. On WSL2 that blocks the GPU in two
ways:

| Symptom | Cause |
|---|---|
| `nvidia-smi` → "GPU access blocked by the operating system"; `cuInit(0)` → `100` (`CUDA_ERROR_NO_DEVICE`) | `/dev/dxg` cannot be opened `O_RDWR` |
| `cuInit(0)` → `304` (`CUDA_ERROR_OPERATING_SYSTEM`) even though `nvidia-smi` works | libcuda writes its thread name to `/proc/self/task/<tid>/comm` during `cuInit` and treats the denied write as fatal |

There the fix is two extra read-write grants: `/dev/dxg` and `/proc`. The
background and the bisection that found them are in
[`docs/why.md`](docs/why.md).

**On the bwrap rung** a writable-path grant is meaningless, because the profile
mounts `--dev /dev`: a brand-new minimal devtmpfs in which `/dev/dxg` does not
exist at all. `ls /dev/dxg` says "No such file or directory" and the GPU is gone
before any permission is even considered. bwrap's platform chain is
`["bwrap", "landlock"]`, probed in order, so **installing bubblewrap silently
switches a working Landlock setup to this rung** — and a Landlock-only fix stops
being applied at the same moment. The device has to be mounted in instead:

```
--dev-bind /dev/dxg /dev/dxg
```

`/proc` needs nothing on this rung: the profile's own `--proc /proc` mounts a
fresh procfs, in which the confined process can already write its own task
`comm`.

### Position is part of the fix

`--dev-bind` must land **after** `--dev <dest>` in the bwrap argv, because
`--dev` mounts the fresh devtmpfs *over* `/dev`. A bind placed before it is
covered by that mount and the device disappears again — with no bwrap error and
no nonzero exit, i.e. exactly the symptom being fixed, silently restored:

```console
$ bwrap --ro-bind / / --dev-bind /dev/dxg /dev/dxg --dev /dev … -- ls /dev/dxg
ls: cannot access '/dev/dxg': No such file or directory

$ bwrap --ro-bind / / --dev /dev --dev-bind /dev/dxg /dev/dxg … -- ls /dev/dxg
crw-rw-rw- 1 nobody nobody 10, 258 /dev/dxg
```

## What it does

While the plugin row is mounted it wraps the public `ctx.sandbox.confine()` seam,
calls the original, then reads the runner off the **resolved** `ConfinedArgv` and
edits that runner's own dialect, for the configured sandbox modes only:

| Selected runner | Edit |
|---|---|
| Landlock launcher | insert `--rw <path>` for each `readWrite` path, before the `--` separator |
| bwrap | insert `--dev-bind <path> <path>` for each `deviceBinds` path, anchored immediately after `--dev <dest>` |

Any other runner is left untouched and warned about once. It does **not** patch
any vendor file, disable the sandbox, or touch the approval policy, and it
restores the original method when the row unloads.

The runner is read off the resolved result on purpose: `confine(argv, policy)`
receives the *caller's* command (`['bash', '-c', …]`) and picks the runner
internally, so the caller's argv never names it. Detecting the backend from that
argv cannot work.

## Requirements

- WSL2 with working GPU passthrough — `nvidia-smi` must already work in a normal
  (unsandboxed) WSL terminal.
- DSH with `dsh-sandbox-local`, on **either** runner:
  - **Landlock** (bubblewrap not installed) — a kernel with Landlock
    (`landlock-run --probe` prints `landlock: fully enforced`).
  - **bubblewrap** (`bwrap` on `PATH`) — this rung wins the chain whenever it is
    present, and `readWrite` does not apply to it; see `deviceBinds`.
- Tested with `dsh 0.1.2-rc.1` (synchronous `confine`) and `dsh 0.2.0-rc.2`
  (`async confine`, `Promise<ConfinedArgv>`, third `signal` argument) on kernel
  6.18 / WSL 2, against `bubblewrap 0.13.0`.

## Layout

```text
dsh-wsl-gpufix/
├── package.json            # DSH bundle metadata (dsh.bundle.patch)
├── cordis.patch.yml        # bundle patch: inserts the gpu-device-grant row
├── gpu-device-grant.mjs    # the plugin (package entry point)
├── gpu-device-grant.test.mjs
├── home/cordis.patch.yml   # template for the home-layer install (method C)
├── install.sh              # method C installer
├── docs/why.md             # root cause + the bisection that found it
├── SECURITY.md
├── README.md               # this file
└── README.zh.md            # 简体中文
```

## Install

This is a standard DSH bundle plugin (`dsh.bundle.patch` in `package.json`).
Pick **one** install method.

### A. From GitHub (recommended, no clone)

```sh
dsh plugin --profile <profile> add github:Jumqyc/dsh-wsl-gpufix
```

`dsh plugin` forwards to pnpm and then registers the package in
`dsh.profile.bundles` because it declares a bundle patch. Restart the profile,
then [verify](#verify).

### B. From a local clone

```sh
git clone https://github.com/Jumqyc/dsh-wsl-gpufix.git
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-wsl-gpufix
```

Use an absolute path, or `link:.` from inside the clone: relative specs are
anchored to your invoking directory, not to the profile.

### C. Home patch layer — every profile, no profile changes

```sh
bash install.sh
```

Writes `$DSH_HOME/cordis.patch.yml` with a row whose `name` is this clone's
absolute `file://` URL, so the grant applies to **every** profile without
installing a package into any of them. Use this instead of A/B.

### Uninstall

```sh
dsh plugin --profile <profile> remove dsh-wsl-gpufix   # methods A–B
# method C: delete the gpu-device-grant entry from $DSH_HOME/cordis.patch.yml
```

### Install with an AI assistant

Paste this to any DSH agent:

```text
Install the DSH plugin dsh-wsl-gpufix from github:Jumqyc/dsh-wsl-gpufix into profile <profile>:

1. Run: dsh plugin --profile <profile> add github:Jumqyc/dsh-wsl-gpufix
2. Restart the profile (or let patchReload: live reload the patch layer).
3. Check it composed: dsh --profile <profile> --dump-config | grep gpu-device-grant
4. Verify the GPU from a normal workspace-write bash session:
   python -c "import os, torch; os.close(os.open('/dev/dxg', os.O_RDWR)); print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
   Expected: True <GPU name>.
5. If CUDA still fails: cuInit error 100 means /dev/dxg is not reachable;
   error 304 with working nvidia-smi means /proc is not granted. On the Landlock
   runner both belong in the row's readWrite list; on the bwrap runner the device
   belongs in deviceBinds and /proc is already provided by the profile.
6. If `ls /dev/dxg` says "No such file or directory", the runner is bwrap and
   the bind was not injected or landed before `--dev /dev`. Check the row's
   deviceBinds list and the plugin's warn log.
```

## Verify

From a normal agent `bash` session (default `workspace-write` mode):

```sh
python -c "import os, torch; os.close(os.open('/dev/dxg', os.O_RDWR)); print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

Expected: `True <your GPU>`.

Use `os.open(..., os.O_RDWR)`, not `open(path, 'r+b')`: the buffered `open`
seeks, and a character device is not seekable, so it raises
`UnsupportedOperation: File or stream is not seekable` *after* the permission
check succeeded — that is not a denial.

## Config

| Key | Default | Meaning |
|---|---|---|
| `readWrite` | `['/dev/dxg', '/proc']` | Absolute paths granted read+write — **Landlock runner only**. Paths that do not exist at call time are skipped (the launcher fails closed on an unopenable grant root, so a missing device must never be granted). |
| `deviceBinds` | `['/dev/dxg']` | Absolute device nodes mounted into the sandbox with `--dev-bind <path> <path>` — **bwrap runner only**. Missing paths are skipped: bwrap fails the whole command on an unbindable source. |
| `modes` | `['workspace-write']` | Sandbox modes the edit applies to. Add `read-only` to allow GPU use there; `danger-full-access` never confines and needs nothing. |

The two path lists are deliberately not interchangeable. Landlock cannot express
a device-node mount, and bwrap cannot express `--rw /proc` — binding the host
procfs would defeat the profile's own `--proc /proc`. Each runner reads only the
list it can honour, so under bwrap `readWrite` has no effect at all.

Minimal config for users who only need NVML (`nvidia-smi`) on the Landlock
runner — note CUDA will still fail with error 304:

```yaml
config:
  readWrite: ['/dev/dxg']
```

## Security

This plugin deliberately **widens** the sandbox by the paths you configure. Read
[`SECURITY.md`](SECURITY.md) before deploying it anywhere shared. In short:

- It only appends runner options to the argv `dsh-sandbox-local` already built:
  `--rw` on the Landlock runner, `--dev-bind` on the bwrap runner. It cannot
  disable the sandbox, alter approval policy, or run code from config.
- On the Landlock runner, `/proc` is broader than a single file. It is required
  for CUDA initialization; DAC still limits writes under `/proc` to the process's
  own entries and root-owned sysctls, and the launcher keeps `no_new_privs` set.
- On the bwrap runner only the named device nodes are mounted, one
  `--dev-bind <path> <path>` per entry. It never uses `--dev-bind /dev /dev`,
  which would hand the sandbox every block, input and random device on the host
  and undo the minimal `/dev` that `--dev /dev` exists to provide.
- The edit applies only to the modes you list (default `workspace-write`).

## Troubleshooting

| Symptom | Check |
|---|---|
| GPU still blocked | Is the row composed? `dsh --profile <profile> --dump-config \| grep gpu-device-grant` (bundle methods A–B) or `$DSH_HOME/cordis.patch.yml` (method C) |
| `ls /dev/dxg` → "No such file or directory" | the runner is bwrap: the row's `deviceBinds` must name `/dev/dxg`, and the plugin must be new enough to inject `--dev-bind`. This is the bwrap-only failure — a missing node, not a permission denial |
| `cuInit` = 304, `nvidia-smi` works | on Landlock, `/proc` is not granted (or was filtered out); on bwrap this cannot happen, `/proc` comes from the profile |
| Row logs "neither the Landlock launcher nor bwrap" | the selected runner is some other backend (e.g. Seatbelt, the Windows ACL runner, or a custom `runnerCommand`) and no edit was applied |
| Row logs "no --dev <dest> before the separator" | a bwrap profile that does not mount a devtmpfs — the bind would be covered by it, so the plugin declines rather than reproducing the original bug |
| Every confined command fails with `TypeError: Cannot read properties of undefined (reading '0')` | the wrapper read `.argv` off the promise: `confine` is `async` since dsh 0.1.3. Update the plugin — it now mirrors sync/async and forwards `signal` |
| Every confined command fails with `bwrap: Unknown option --rw` | an old plugin injected Landlock flags into a bwrap profile; update it |
| `dxgkio_query_adapter_info: Ioctl failed: -22` in `dmesg` | pre-existing WSL noise; also appears in a working unsandboxed terminal |
| GPU blocked in `read-only` mode | add `read-only` to `modes` |

## Compatibility

The plugin depends on `LocalSandboxProvider.prototype.confine` existing, on the
Landlock launcher's `--rw` flag contract, and on bwrap's
`--dev /dev … --dev-bind …` profile shape. If a future DSH release changes any of
them, the row logs a warning and the sandbox keeps working without the GPU
grant — it fails soft, never open. Re-run the verification command after
upgrading DSH.

`confine` is synchronous before dsh 0.1.3 and `async` from 0.1.3 on (returning
`Promise<ConfinedArgv>`, with a third `signal` argument). The wrapper mirrors
whichever shape the host hands it — a thenable is awaited before the grants are
injected — so both hosts are supported. Do not read `confined.argv` directly:
on an async host that is `undefined`, and `undefined[0]` throws inside every
confined command.

## Tests

```sh
node --test
```

Hermetic: no GPU, no `/dev/dxg`, no sandbox required.

The wrapper is also checked against a *real* `dsh-sandbox-local` installation,
whose `confine` is `async` since dsh 0.1.3 and takes a third `signal` argument.
That check exercises both runners — it pins the provider's chain to `landlock`
and to `bwrap` in turn — and asserts the injected argv, including that the bwrap
bind lands right after `--dev /dev`. It needs the host's dsh install, so it is a
separate script rather than part of `node --test`:

```sh
node gpu-device-grant.integration.mjs
DSH_SANDBOX_LOCAL=/path/to/dsh-sandbox-local/lib/index.js node gpu-device-grant.integration.mjs
```

## License

[MIT](LICENSE)

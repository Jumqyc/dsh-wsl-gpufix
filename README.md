# dsh-wsl-gpufix

[English](README.md) | [简体中文](README.zh.md)

A Cordis host-composition plugin for [DSH](https://github.com/deepseek-ai) that
grants the WSL2 GPU device to the DSH Landlock sandbox, so `torch.cuda.is_available()`
is `True` inside a normal (confined) agent `bash` session.

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

`@deepseek-ai/dsh-sandbox-local` builds its Landlock profile from a hard-coded
list — `/dev/null` always, plus `/tmp` and the workspace root under
`workspace-write`. Nothing else is writable, and there is no config field for
extra paths. On WSL2 that blocks the GPU in two ways:

| Symptom | Cause |
|---|---|
| `nvidia-smi` → "GPU access blocked by the operating system"; `cuInit(0)` → `100` (`CUDA_ERROR_NO_DEVICE`) | `/dev/dxg` cannot be opened `O_RDWR` |
| `cuInit(0)` → `304` (`CUDA_ERROR_OPERATING_SYSTEM`) even though `nvidia-smi` works | libcuda writes its thread name to `/proc/self/task/<tid>/comm` during `cuInit` and treats the denied write as fatal |

The fix is two extra read-write grants: `/dev/dxg` and `/proc`. The background
and the bisection that found them are in [`docs/why.md`](docs/why.md).

## What it does

While the plugin row is mounted it wraps the public `ctx.sandbox.confine()` seam
and inserts `--rw <path>` grants before the `--` argv separator, only for the
configured sandbox modes and only when the selected runner is the Landlock
launcher. It does **not** patch any vendor file, disable Landlock, or touch the
approval policy, and it restores the original method when the row unloads.

## Requirements

- WSL2 with working GPU passthrough — `nvidia-smi` must already work in a normal
  (unsandboxed) WSL terminal.
- DSH with `dsh-sandbox-local` selecting its **Landlock** runner (bubblewrap is
  not installed). Tested with `dsh 0.1.2-rc.1` on kernel 6.18 / WSL 2.7.13.
- A kernel with Landlock (`landlock-run --probe` prints `landlock: fully enforced`).

## Layout

```text
dsh-wsl-gpufix/
├── package.json            # DSH bundle metadata (dsh.bundle.patch)
├── cordis.patch.yml        # bundle patch: inserts the gpu-device-grant row
├── gpu-device-grant.mjs    # the plugin (package entry point)
├── gpu-device-grant.test.mjs
├── home/cordis.patch.yml   # template for the home-layer install (method D)
├── install.sh              # method D installer
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

### C. From npm (after `npm publish`)

```sh
dsh plugin --profile <profile> add dsh-wsl-gpufix
```

### D. Home patch layer — every profile, no profile changes

```sh
bash install.sh
```

Writes `$DSH_HOME/cordis.patch.yml` with a row whose `name` is this clone's
absolute `file://` URL, so the grant applies to **every** profile without
installing a package into any of them. Use this instead of A/B/C.

### Uninstall

```sh
dsh plugin --profile <profile> remove dsh-wsl-gpufix   # methods A–C
# method D: delete the gpu-device-grant entry from $DSH_HOME/cordis.patch.yml
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
5. If CUDA still fails: cuInit error 100 means /dev/dxg is not granted;
   error 304 with working nvidia-smi means /proc is not granted. Both belong in
   the row's readWrite list.
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
| `readWrite` | `['/dev/dxg', '/proc']` | Absolute paths granted read+write inside the sandbox. Paths that do not exist at call time are skipped (the launcher fails closed on an unopenable grant root, so a missing device must never be granted). |
| `modes` | `['workspace-write']` | Sandbox modes the grant applies to. Add `read-only` to allow GPU use there; `danger-full-access` never confines and needs nothing. |

Minimal config for users who only need NVML (`nvidia-smi`) — note CUDA will
still fail with error 304:

```yaml
config:
  readWrite: ['/dev/dxg']
```

## Security

This plugin deliberately **widens** the sandbox by the paths you configure. Read
[`SECURITY.md`](SECURITY.md) before deploying it anywhere shared. In short:

- It can only append `--rw` flags to the Landlock argv; it cannot disable the
  sandbox, alter approval policy, or run code from config.
- `/proc` is broader than a single file. It is required for CUDA initialization;
  DAC still limits writes under `/proc` to the process's own entries and
  root-owned sysctls, and the launcher keeps `no_new_privs` set.
- The grant applies only to the modes you list (default `workspace-write`).

## Troubleshooting

| Symptom | Check |
|---|---|
| GPU still blocked | Is the row composed? `dsh --profile <profile> --dump-config \| grep gpu-device-grant` (bundle methods A–C) or `$DSH_HOME/cordis.patch.yml` (method D) |
| `cuInit` = 304, `nvidia-smi` works | `/proc` is not granted (or was filtered out) |
| Row logs "not the Landlock launcher" | bubblewrap is installed and won the runner chain; bwrap needs `--dev-bind /dev/dxg /dev/dxg`, a different profile change |
| `dxgkio_query_adapter_info: Ioctl failed: -22` in `dmesg` | pre-existing WSL noise; also appears in a working unsandboxed terminal |
| GPU blocked in `read-only` mode | add `read-only` to `modes` |

## Compatibility

The plugin depends on `LocalSandboxProvider.prototype.confine` existing and on
the Landlock launcher's `--rw` flag contract. If a future DSH release changes
either, the row logs a warning and the sandbox keeps working without the GPU
grant — it fails soft, never open. Re-run the verification command after
upgrading DSH.

## Tests

```sh
node --test
```

Hermetic: no GPU, no `/dev/dxg`, no sandbox required.

## License

[MIT](LICENSE)

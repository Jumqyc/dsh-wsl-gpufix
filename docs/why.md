# Why two grants are needed

This is the background behind `gpu-device-grant`: how the two missing Landlock
grants were identified, and why the fix is a plugin rather than a one-line patch
of the DSH sandbox package.

## Symptom

On a WSL2 host where the GPU works in a normal terminal, a DSH agent `bash`
session (default `workspace-write` mode) reported:

```console
$ nvidia-smi
Failed to initialize NVML: GPU access blocked by the operating system

$ python -c "import torch; print(torch.cuda.is_available())"
False
# RuntimeError: Found no NVIDIA driver on your system
```

The WSL/driver stack was healthy: the same commands succeeded outside the
sandbox, and `dmesg` showed only the known benign `dxgkio_query_adapter_info:
Ioctl failed: -22` lines that also appear in a working terminal.

## Why the sandbox blocks it

`@deepseek-ai/dsh-sandbox-local` builds the Landlock profile from a hard-coded
list:

```js
const readWrite = ["/dev/null"];
if (policy.mode === "workspace-write") readWrite.push("/tmp", policy.workspaceRoot);
return grantArgs({ readOnly: ["/"], readWrite });
```

Everything else is read-only. There is no supported config field for extra
writable paths in `dsh-sandbox-local`, `dsh-sandbox-policy`, or
`dsh-permission-presets`, so a confined process can open `/dev/dxg` read-only
but not `O_RDWR`.

The runner on this host is the Landlock launcher (bubblewrap is not installed,
and the platform chain `["bwrap", "landlock"]` probes and selects Landlock). The
launcher already supports file-level grants — `/dev/null` is granted the same
way — including `LANDLOCK_ACCESS_FS_IOCTL_DEV` on ABI ≥ 5, which GPU ioctls
need.

## Finding the first grant: `/dev/dxg`

With a temporary Cordis plugin wrapping `ctx.sandbox.confine()` and appending
`--rw /dev/dxg`, NVML started working (`nvidia-smi` printed the card) but CUDA
still failed:

```console
$ python -c "import ctypes; print(ctypes.CDLL('libcuda.so.1').cuInit(0))"
304          # CUDA_ERROR_OPERATING_SYSTEM
```

## Finding the second grant: `/proc`

Bisecting the grant set (each row verified live, without restarting the harness)
isolated it:

| extra grants | `cuInit(0)` | observation |
|---|---|---|
| none (shipped `workspace-write`) | `100` | `/dev/dxg` O_RDWR denied |
| `+ /dev/dxg` | `304` | NVML works, CUDA does not |
| `+ /dev/dxg /dev/shm` | `304` | not shared memory |
| `+ /dev/dxg /proc` | `0` | full CUDA |
| `+ /dev/dxg /` | `0` | control: proves a filesystem denial, not a driver fault |
| `+ /dev/dxg /proc/self` | `304` | see below |

A small `LD_PRELOAD` tracer (interposing `fopen`/`open`/`openat`/`ioctl` and the
raw `syscall` wrapper) named the exact failing call in the `cuInit` path:

```console
[shim] fopen(/proc/self/task/<tid>/comm) -> Permission denied
cuInit(0) = 304
```

libcuda writes its thread name to `/proc/self/task/<tid>/comm` during `cuInit`
and treats a denied write as a fatal OS error, even though the device itself is
reachable.

## Why `/proc` and not `/proc/self`

The Landlock launcher resolves every `--rw` path **in its own process**, so
`--rw /proc/self` attaches the rule to the inode of the launcher/`bash` pid. The
CUDA call happens in a descendant process (`bash -c python …`), whose
`/proc/self` is a different directory and therefore not under that rule. Only a
rule on the procfs mount root covers all pids, so `/proc` is the narrowest
reliable grant.

## Why a plugin instead of patching the vendor file

Pushing `"/dev/dxg"` and `"/proc"` into the `readWrite` list inside
`dsh-sandbox-local/lib/index.js` also works, but it edits the deployment
installation, is overwritten by DSH/profile updates, and needs a process restart
to take effect (the module is already loaded).

The home patch layer `$DSH_HOME/cordis.patch.yml` is the harness's own extension
mechanism: user config, hot-reloaded with `patchReload: live`, no vendor file
touched, and one line to remove. It is host-plane composition — the sandbox is a
host capability — not an agent preset, because a preset must not relax its own
confinement.

## Reproducing the diagnosis

1. Mount a temporary host plugin that wraps `ctx.sandbox.confine()` and appends
   `--rw <candidate>` before the `--` separator (see the plugin source for the
   exact shape).
2. Run `cuInit` through `ctypes` and bisect candidates.
3. If a candidate fixes `cuInit` but you cannot see which file is denied, build
   a tiny `LD_PRELOAD` shim that logs failing `fopen`/`open`/`openat`/`ioctl`
   calls. `fopen` matters: glibc's `fopen` uses a hidden internal `open`, so a
   shim that only interposes `open` misses it.

## A probe that lies

`open('/dev/dxg', 'r+b')` is not a valid permission probe. Python's buffered
`open` seeks, and a character device is not seekable, so it raises
`UnsupportedOperation: File or stream is not seekable` **after** the permission
check succeeded. Use:

```sh
python -c "import os; os.close(os.open('/dev/dxg', os.O_RDWR))"
```

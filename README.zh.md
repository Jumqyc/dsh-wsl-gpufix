# dsh-wsl-gpufix

[![test](https://github.com/Jumqyc/dsh-wsl-gpufix/actions/workflows/test.yml/badge.svg)](https://github.com/Jumqyc/dsh-wsl-gpufix/actions/workflows/test.yml)

**社区非官方插件，与 DeepSeek 官方无关，未获官方背书。**

[English](README.md) | 简体中文

一个 DSH（DeepSeek Harness）宿主侧 Cordis 插件：把 WSL2 的 GPU 设备授权给 DSH 的
Landlock 沙箱，让普通（受限）agent `bash` 会话里的 `torch.cuda.is_available()` 变为
`True`。

```console
$ python -c "import os, torch; os.close(os.open('/dev/dxg', os.O_RDWR)); print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
True NVIDIA GeForce RTX 4060 Laptop GPU
```

一条命令安装：

```sh
dsh plugin --profile <profile> add github:Jumqyc/dsh-wsl-gpufix
```

---

## 问题

`@deepseek-ai/dsh-sandbox-local` 的 Landlock 授权列表是写死的（永远有 `/dev/null`，
`workspace-write` 下再加 `/tmp` 和 workspace 根目录），没有配置项可以追加路径。在
WSL2 上这会以两种方式挡住 GPU：

| 现象 | 原因 |
|---|---|
| `nvidia-smi` 报 "GPU access blocked by the operating system"，`cuInit(0)` 返回 `100`（`CUDA_ERROR_NO_DEVICE`） | `/dev/dxg` 无法以 `O_RDWR` 打开 |
| `nvidia-smi` 正常但 `cuInit(0)` 返回 `304`（`CUDA_ERROR_OPERATING_SYSTEM`） | libcuda 在 `cuInit` 时向 `/proc/self/task/<tid>/comm` 写线程名，写入被拒后直接判定为致命错误 |

所以需要两条读写授权：`/dev/dxg` 和 `/proc`。完整排查过程见
[`docs/why.md`](docs/why.md)。

## 它做什么

插件挂载期间包装公开的 `ctx.sandbox.confine()` 接口，在 `--` 分隔符前插入
`--rw <path>`，只对配置的 sandbox 模式、且仅在选中 Landlock runner 时生效。它不改
任何 DSH 源码，不关闭 Landlock，不影响审批策略，行卸载后自动还原。

## 环境要求

- WSL2 GPU 直通本身正常（普通未受限终端里 `nvidia-smi` 能用）。
- DSH 选中 `dsh-sandbox-local` 的 **Landlock** runner（未安装 bubblewrap）。已在
  `dsh 0.1.2-rc.1`、kernel 6.18 / WSL 2.7.13 上验证。
- 内核启用 Landlock（`landlock-run --probe` 输出 `landlock: fully enforced`）。

## 安装

本插件是标准 DSH bundle 插件（`package.json` 里的 `dsh.bundle.patch`）。**四选一**。

### 方式 A：从 GitHub 安装（推荐，无需克隆）

```sh
dsh plugin --profile <profile> add github:Jumqyc/dsh-wsl-gpufix
```

`dsh plugin` 会转发给 pnpm，并在成功后自动把该包登记进 `dsh.profile.bundles`。装完重启
该 profile。

### 方式 B：从本地克隆安装

```sh
git clone https://github.com/Jumqyc/dsh-wsl-gpufix.git
dsh plugin --profile <profile> add link:/绝对路径/dsh-wsl-gpufix
```

请用绝对路径（或在仓库目录内用 `link:.`）：相对路径会按你执行命令的目录解析，而不是
profile 目录。

### 方式 C：从 npm 安装（发布之后）

```sh
dsh plugin --profile <profile> add dsh-wsl-gpufix
```

### 方式 D：home patch 层（所有 profile 生效，不改任何 profile）

```sh
bash install.sh
```

会写入 `$DSH_HOME/cordis.patch.yml`，行里的 `name` 是本仓库 `gpu-device-grant.mjs` 的
绝对 `file://` URL，因此对**每个** profile 生效。请与 A/B/C 二选一。

### 卸载

```sh
dsh plugin --profile <profile> remove dsh-wsl-gpufix   # 方式 A–C
# 方式 D：删除 $DSH_HOME/cordis.patch.yml 里的 gpu-device-grant 条目
```

### 让 AI 帮你装

把下面这段直接发给任意 DSH agent：

```text
请帮我安装 DSH 插件 dsh-wsl-gpufix，来源 github:Jumqyc/dsh-wsl-gpufix，装到 <profile>：

1. 执行：dsh plugin --profile <profile> add github:Jumqyc/dsh-wsl-gpufix
2. 重启该 profile（或等待 patchReload: live 重载补丁层）。
3. 确认已生效：dsh --profile <profile> --dump-config | grep gpu-device-grant
4. 在普通 workspace-write bash 会话里验证 GPU：
   python -c "import os, torch; os.close(os.open('/dev/dxg', os.O_RDWR)); print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
   期望输出：True <GPU 名称>。
5. 若仍失败：cuInit 报 100 说明 /dev/dxg 没授权；nvidia-smi 正常但报 304 说明
   /proc 没授权。两条都应出现在该行的 readWrite 里。
```

## 验证

在普通（默认 `workspace-write`）agent `bash` 会话里执行：

```sh
python -c "import os, torch; os.close(os.open('/dev/dxg', os.O_RDWR)); print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

期望 `True <你的 GPU 名称>`。

请用 `os.open(..., os.O_RDWR)`，不要用 `open(path, 'r+b')`：带缓冲的 `open` 会 seek，
而字符设备不可 seek，于是会在**权限检查通过之后**抛
`UnsupportedOperation: File or stream is not seekable`——那不是被拒绝。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `readWrite` | `['/dev/dxg', '/proc']` | 授予沙箱读写的绝对路径。调用时不存在会被跳过（launcher 遇到打不开的授权路径会 fail closed，所以缺失的设备绝不能授权）。 |
| `modes` | `['workspace-write']` | 生效的 sandbox 模式。想让 `read-only` 也能用 GPU 就加进去；`danger-full-access` 本就不受限，无需配置。 |

只跑 `nvidia-smi`（NVML）而不跑 CUDA 的最小配置（注意此时 CUDA 会报 304）：

```yaml
config:
  readWrite: ['/dev/dxg']
```

## 安全

本插件会按你配置的路径**扩大**沙箱边界，请先阅读 [`SECURITY.md`](SECURITY.md)。
要点：

- 它只能往 Landlock 参数里追加 `--rw`，无法关闭沙箱、修改审批策略，也不会执行配置里的代码。
- `/proc` 比单个文件宽（CUDA 初始化必需）。DAC 仍会把 `/proc` 的写入限制在进程自身条目和
  root 所有的 sysctl 上，且 launcher 保持 `no_new_privs`。
- 授权只作用于你列出的模式（默认 `workspace-write`）。

## 故障排查

| 现象 | 检查 |
|---|---|
| GPU 仍被挡 | 行是否已生效：`dsh --profile <profile> --dump-config \| grep gpu-device-grant`（方式 A–C）或 `$DSH_HOME/cordis.patch.yml`（方式 D） |
| `cuInit` = 304 且 `nvidia-smi` 正常 | `/proc` 没授权（或不存在被跳过） |
| 日志提示 "not the Landlock launcher" | 装了 bubblewrap 并抢到了 runner；bwrap 需要 `--dev-bind /dev/dxg /dev/dxg`，是另一种改法 |
| `dmesg` 里 `dxgkio_query_adapter_info: Ioctl failed: -22` | WSL 既有噪声，未受限终端同样出现 |
| `read-only` 模式下 GPU 被挡 | 把 `read-only` 加入 `modes` |

## 兼容性

插件依赖 `LocalSandboxProvider.prototype.confine` 存在、以及 Landlock launcher 的
`--rw` 参数契约。若未来 DSH 改动其中任一，该行会打 warning 并停止授权，但沙箱继续正常
工作——失败方向是「更安全」，不会放开。升级 DSH 后重跑验证命令即可。

## 测试

```sh
node --test
```

测试不依赖 GPU、`/dev/dxg` 或真实沙箱。

## 许可证

[MIT](LICENSE)

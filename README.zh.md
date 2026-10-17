# dsh-wsl-gpufix

[![test](https://github.com/Jumqyc/dsh-wsl-gpufix/actions/workflows/test.yml/badge.svg)](https://github.com/Jumqyc/dsh-wsl-gpufix/actions/workflows/test.yml)

**社区非官方插件，与 DeepSeek 官方无关，未获官方背书。**

[English](README.md) | 简体中文

一个 DSH（DeepSeek Harness）宿主侧 Cordis 插件：让 WSL2 的 GPU 设备在 DSH 本地沙箱里
可用，使普通（受限）agent `bash` 会话里的 `torch.cuda.is_available()` 变为 `True`——
**无论** `dsh-sandbox-local` 最终选中 Landlock runner 还是 bubblewrap。

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

`@deepseek-ai/dsh-sandbox-local` 把两个 runner 的 profile 都写死了，而两者都没能用上
`/dev/dxg`。

**Landlock 这一档**的授权列表是写死的（永远有 `/dev/null`，`workspace-write` 下再加
`/tmp` 和 workspace 根目录），没有配置项可以追加路径。在 WSL2 上这会以两种方式挡住 GPU：

| 现象 | 原因 |
|---|---|
| `nvidia-smi` 报 "GPU access blocked by the operating system"，`cuInit(0)` 返回 `100`（`CUDA_ERROR_NO_DEVICE`） | `/dev/dxg` 无法以 `O_RDWR` 打开 |
| `nvidia-smi` 正常但 `cuInit(0)` 返回 `304`（`CUDA_ERROR_OPERATING_SYSTEM`） | libcuda 在 `cuInit` 时向 `/proc/self/task/<tid>/comm` 写线程名，写入被拒后直接判定为致命错误 |

所以这一档需要两条读写授权：`/dev/dxg` 和 `/proc`。完整排查过程见
[`docs/why.md`](docs/why.md)。

**bwrap 这一档**加"可写路径授权"没有意义，因为它的 profile 会挂 `--dev /dev`：一个全新的
最小 devtmpfs，里面**根本不存在** `/dev/dxg`。`ls /dev/dxg` 直接报 "No such file or
directory"——权限都还没轮到检查。bwrap 的平台链是 `["bwrap", "landlock"]` 并按序探测，所以
**装上 bubblewrap 就会把原本可用的 Landlock 配置静默切到这一档**，同时只针对 Landlock 的
修复也一起失效。设备必须被挂进去：

```
--dev-bind /dev/dxg /dev/dxg
```

这一档不需要处理 `/proc`：profile 自带的 `--proc /proc` 挂的是新 procfs，受限进程本来就能
写自己的 task `comm`。

### 位置本身就是修复的一部分

`--dev-bind` 必须落在 `--dev <dest>` **之后**，因为 `--dev` 会把新 devtmpfs 挂在 `/dev`
之上。放在它之前会被这次挂载盖掉，设备再次消失——而且 bwrap 不报错、退出码也是 0，也就是
把要修的故障原样静默恢复：

```console
$ bwrap --ro-bind / / --dev-bind /dev/dxg /dev/dxg --dev /dev … -- ls /dev/dxg
ls: cannot access '/dev/dxg': No such file or directory

$ bwrap --ro-bind / / --dev /dev --dev-bind /dev/dxg /dev/dxg … -- ls /dev/dxg
crw-rw-rw- 1 nobody nobody 10, 258 /dev/dxg
```

## 它做什么

插件挂载期间包装公开的 `ctx.sandbox.confine()` 接口：先调用原方法，再从**已解析的**
`ConfinedArgv` 里读出实际选中的 runner，按其自身方言改写，且只对配置的 sandbox 模式生效：

| 选中的 runner | 改写方式 |
|---|---|
| Landlock launcher | 为每个 `readWrite` 路径在 `--` 分隔符前插入 `--rw <path>` |
| bwrap | 为每个 `deviceBinds` 路径紧跟在 `--dev <dest>` 之后插入 `--dev-bind <path> <path>` |

其它 runner 一律不动，只打一次 warning。它不改任何 DSH 源码，不关闭沙箱，不影响审批策略，
行卸载后自动还原。

runner 之所以要从解析结果里读：`confine(argv, policy)` 收到的是**调用方自己的**命令
（`['bash', '-c', …]`），runner 是它内部选的，调用方 argv 里从来不含它。从那个 argv 反推
后端是不可能成立的。

## 环境要求

- WSL2 GPU 直通本身正常（普通未受限终端里 `nvidia-smi` 能用）。
- DSH 使用 `dsh-sandbox-local`，两个 runner **任一**皆可：
  - **Landlock**（未安装 bubblewrap）：内核启用 Landlock
    （`landlock-run --probe` 输出 `landlock: fully enforced`）。
  - **bubblewrap**（`PATH` 里有 `bwrap`）：只要它存在就会赢下 runner 链，此时 `readWrite`
    对它无效，见 `deviceBinds`。
- 已在 `dsh 0.1.2-rc.1`（同步 `confine`）与 `dsh 0.2.0-rc.2`（`async confine`、
  `Promise<ConfinedArgv>`、第三个 `signal` 参数）上验证，内核 6.18 / WSL 2，
  `bubblewrap 0.13.0`。

## 安装

本插件是标准 DSH bundle 插件（`package.json` 里的 `dsh.bundle.patch`）。**三选一**。

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

### 方式 C：home patch 层（所有 profile 生效，不改任何 profile）

```sh
bash install.sh
```

会写入 `$DSH_HOME/cordis.patch.yml`，行里的 `name` 是本仓库 `gpu-device-grant.mjs` 的
绝对 `file://` URL，因此对**每个** profile 生效。请与 A/B 二选一。

### 卸载

```sh
dsh plugin --profile <profile> remove dsh-wsl-gpufix   # 方式 A–B
# 方式 C：删除 $DSH_HOME/cordis.patch.yml 里的 gpu-device-grant 条目
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
5. 若仍失败：cuInit 报 100 说明 /dev/dxg 不通；nvidia-smi 正常但报 304 说明 /proc 没
   授权。Landlock 档这两条都写进该行的 readWrite；bwrap 档设备写进 deviceBinds，
   /proc 由 profile 自带。
6. 若 `ls /dev/dxg` 报 "No such file or directory"，说明 runner 是 bwrap 且 --dev-bind
   没注入、或落在了 `--dev /dev` 之前。检查该行的 deviceBinds 与插件 warning 日志。
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
| `readWrite` | `['/dev/dxg', '/proc']` | 授予沙箱读写的绝对路径——**仅 Landlock 档**。调用时不存在会被跳过（launcher 遇到打不开的授权路径会 fail closed，所以缺失的设备绝不能授权）。 |
| `deviceBinds` | `['/dev/dxg']` | 用 `--dev-bind <path> <path>` 挂进沙箱的绝对设备节点——**仅 bwrap 档**。不存在的会被跳过：bwrap 遇到绑不上的源会让整条命令失败。 |
| `modes` | `['workspace-write']` | 生效的 sandbox 模式。想让 `read-only` 也能用 GPU 就加进去；`danger-full-access` 本就不受限，无需配置。 |

两个路径列表刻意不通用：Landlock 表达不了设备节点挂载，bwrap 也表达不了 `--rw /proc`
（把宿主 procfs 绑进去会破坏 profile 自带的 `--proc /proc`）。每个 runner 只读自己能兑现
的那个列表，所以在 bwrap 档下 `readWrite` 完全不生效。

Landlock 档下只跑 `nvidia-smi`（NVML）而不跑 CUDA 的最小配置（注意此时 CUDA 会报 304）：

```yaml
config:
  readWrite: ['/dev/dxg']
```

## 安全

本插件会按你配置的路径**扩大**沙箱边界，请先阅读 [`SECURITY.md`](SECURITY.md)。
要点：

- 它只是往 `dsh-sandbox-local` 已经构造好的 argv 上追加 runner 参数：Landlock 档加
  `--rw`，bwrap 档加 `--dev-bind`。它无法关闭沙箱、修改审批策略，也不会执行配置里的代码。
- Landlock 档下 `/proc` 比单个文件宽（CUDA 初始化必需）。DAC 仍会把 `/proc` 的写入限制在
  进程自身条目和 root 所有的 sysctl 上，且 launcher 保持 `no_new_privs`。
- bwrap 档下只挂你点名的设备节点，一条 `--dev-bind <path> <path>` 对应一个。它绝不使用
  `--dev-bind /dev /dev`——那会把宿主机所有块设备、输入设备、随机数设备都交给沙箱，正好
  废掉 `--dev /dev` 建立最小 `/dev` 的目的。
- 改写只作用于你列出的模式（默认 `workspace-write`）。

## 故障排查

| 现象 | 检查 |
|---|---|
| GPU 仍被挡 | 行是否已生效：`dsh --profile <profile> --dump-config \| grep gpu-device-grant`（方式 A–B）或 `$DSH_HOME/cordis.patch.yml`（方式 C） |
| `ls /dev/dxg` 报 "No such file or directory" | runner 是 bwrap：该行的 `deviceBinds` 必须含 `/dev/dxg`，且插件要新到会注入 `--dev-bind`。这是 bwrap 档特有的"节点不存在"，不是权限被拒 |
| `cuInit` = 304 且 `nvidia-smi` 正常 | Landlock 档下 `/proc` 没授权（或不存在被跳过）；bwrap 档不会出现，`/proc` 由 profile 自带 |
| 日志提示 "neither the Landlock launcher nor bwrap" | 选中的是别的后端（如 Seatbelt、Windows ACL runner，或自定义 `runnerCommand`），没有做任何改写 |
| 日志提示 "no --dev <dest> before the separator" | 该 bwrap profile 不挂 devtmpfs——bind 会被它盖掉，所以插件宁可不注入，也不重演原故障 |
| 每条受限命令都失败并报 `TypeError: Cannot read properties of undefined (reading '0')` | 包装层从 promise 上读了 `.argv`：`confine` 自 dsh 0.1.3 起是 `async`。升级插件——现在会同步/异步自适应并转发 `signal` |
| 每条受限命令都失败并报 `bwrap: Unknown option --rw` | 旧版插件把 Landlock 参数注入了 bwrap profile，升级即可 |
| `dmesg` 里 `dxgkio_query_adapter_info: Ioctl failed: -22` | WSL 既有噪声，未受限终端同样出现 |
| `read-only` 模式下 GPU 被挡 | 把 `read-only` 加入 `modes` |

## 兼容性

插件依赖 `LocalSandboxProvider.prototype.confine` 存在、Landlock launcher 的 `--rw` 参数
契约，以及 bwrap 的 `--dev /dev … --dev-bind …` profile 形状。若未来 DSH 改动其中任一，
该行会打 warning 并停止改写，但沙箱继续正常工作——失败方向是「更安全」，不会放开。升级
DSH 后重跑验证命令即可。

## 测试

```sh
node --test
```

测试不依赖 GPU、`/dev/dxg` 或真实沙箱。

## 许可证

[MIT](LICENSE)

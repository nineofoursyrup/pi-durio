# #12 受限执行探查

本目录实现一条 macOS arm64 上可重复的 Node 探查路径。它不是产品 eval runner；#21 必须把真实共用 runtime 接入并重新验证。

## 固定机制

使用 Apple `container` **1.4.1** 的每容器独立 Linux VM。受限入口固定为：

```text
container create (read-only root, three explicit mounts, no forwarded sockets)
  → unshare --net
  → setpriv (UID/GID 1000, empty capabilities/groups, no_new_privs)
  → restrict.py (libseccomp policy, inherited by fork/exec)
  → Node / candidate runtime / its tools
```

Apple CLI 1.4.1 默认连接 VM 网络，没有 `--network none`。`--no-dns` 只是补充配置。断网保证来自独立 network namespace **以及**加载进 Linux 内核的固定 seccomp 规则：`socket`/`socketpair` 仅允许 AF_UNIX，显式阻断 IPv4、IPv6、AF_VSOCK、netlink、packet 等协议族。另阻断 setns、unshare、ptrace、process_vm_*、pidfd_getfd、bpf、io_uring_setup。规则添加或加载失败立即退出，候选不会执行。没有本机 shell 回退。

VM 内启动前短暂保有 SYS_ADMIN/SETUID/SETGID/SETPCAP，只用于 `unshare` 和 `setpriv`；候选开始前所有 capability 集、bounding set 和 supplementary groups 已清空。`no_new_privs` 与 seccomp 跨后代进程继承。`restrict.py` 只是一个固定策略装载器，使用系统 libseccomp，没有自有执行 loop 或多后端 API。

只挂载 `/input`（fixture 副本，只读）、`/boundary`（固定入口，只读）、`/work`（本 trial 独占）。原始 fixture、计划、grader、隐藏预期、其他 trial 与宿主控制通道均不挂载。HOME、TMPDIR、cache 分别位于新 `/work` 下；rootfs/依赖只读，guest 的 `/dev`、`/proc` 等来自 VM/容器自身。没有 SSH agent、宿主 socket、共享 Git 或端口转发。

执行结束或超时后必须完成 `stop → inspect stopped → delete → list absent`。停止整个 VM 结束其所有后代，不能把 CLI 退出或杀掉 client 当作停止证据。任一控制步骤无法确认，结果是 `invalid/termination_unconfirmed`，不导出、不复用目录、不启动受影响后续试次。输出管道关闭不能阻塞独立清理。

## 准备和运行

宿主需要 Node（本次 v26.8.2），Apple silicon、macOS 26+，以及 CLI 1.4.1。本次实际系统是 macOS 27.2 / 26B5101f。安装只发生在明确的准备阶段，不在受限候选内执行。CLI 的安装包与 VM 镜像属于 eval 环境依赖，不能算成产品 npm 体积。

```sh
# 安装得到的版本必须是 1.4.1；其他版本需要重新探查，runner 会拒绝。
brew install container
container --version
container system start --enable-kernel-install

# 始终指定 arm64；省略时 CLI 会拉取全部平台。
container image pull --platform linux/arm64 docker.io/library/node:24.8.0-bookworm-slim
container build --platform linux/arm64 --file scripts/isolation/Containerfile \
  --tag pi-durio-isolation:issue12-v1 scripts/isolation
container image inspect pi-durio-isolation:issue12-v1
```

`Containerfile` 固定 base index digest、Python 与 libseccomp 顶层包版本；传递 Debian 包可能随仓库更新，所以**重建后的 digest 不保证相同**。先读取实际 digest 并保留完整 image，再为该 digest 注册引用，重新验证。宿主同时检查 image metadata 和已创建容器中的 digest，不能仅相信引用名称。

本次固定 image 引用：

```sh
container image tag pi-durio-isolation:issue12-v1 \
  pi-durio-isolation@sha256:998e7dbfb5f4f7abfb8ada97a6706bb6fe0f0a1b98a789873b4d2b6a7b78f62b

node scripts/isolation/probe.mjs /absolute/path/to/new-evidence-directory \
  pi-durio-isolation@sha256:998e7dbfb5f4f7abfb8ada97a6706bb6fe0f0a1b98a789873b4d2b6a7b78f62b

DURIO_ISOLATION_IMAGE=pi-durio-isolation@sha256:998e7dbfb5f4f7abfb8ada97a6706bb6fe0f0a1b98a789873b4d2b6a7b78f62b \
  node --test scripts/isolation/test/*.test.mjs
```

未设置 `DURIO_ISOLATION_IMAGE` 时，只运行本地导出/拒绝测试，真实 VM 测试显示 SKIP；这不构成隔离通过。探查目标目录必须不存在；重跑须新目录，首败不覆盖。

本次完整 OCI 工件与 kernel 已保存到 `/Users/nineofour/pi-durio-v1-run/evidence/issue-12/`。离线恢复可用 `container image load --input prepared-image.oci.tar`，并用 `container system kernel set --binary <保存的 kernel>` 设置同一 kernel；核对 SHA256 与 digest 后重新探查。CLI 缺失、服务未启动、image 缺失、版本不符、配置/终止未知都失败关闭。

## #21 的接线接缝

`boundary.mjs` 导出 `runRestricted({ image, inputDir, runDir, command, timeoutMs, model? })` 和 `exportStopped(execution, names, destination)`。这些参数全部由可信 runner 构造，不能直接映射候选 JSON。

- `inputDir` 是此次受限代码/依赖的输入；模块再制作只读副本。`runDir` 必须是全新独占路径，原始可信证据留在其挂载范围外。候选共用 runtime 和工具一起运行在 guest 内。
- `command` 是 VM 内 argv，没有宿主 shell。默认 CLI 路径 `/opt/homebrew/bin/container`；`containerExecutable` 仅用于注入真实控制命令的故障测试，生产入口应固定它。
- `model = { maxRequests, maxOutputTokens, request({ input, maxOutputTokens, signal }) }` 是宿主持有的回调。#21 将此接到已有 provider 入口，并由同一边界落实持久预算、attempt、compaction/重试归属。probe 只用返回字面量 `42` 的确定性替身，未实现付费 provider 或持久预算账本。
- guest 仅能向 stdout 写一行 `{ "kind":"model.request", "id":1, "input":"...", "maxOutputTokens":8 }`，host 从 stdin 返回 `{ "kind":"model.response", "id":1, "output":"..." }`。严格校验字段、顺序、大小、次数和输出上限；URL、凭据、模型选择、命令或路径等额外字段会被拒绝。密钥仅存在 host callback 闭包/环境，工具环境不继承。AbortSignal 通知回调停止；在途未完成请求保留 unknown，不当作未发生。
- `exportStopped` 只接受本进程由真实停止核对产生的结果对象，伪造对象/invalid 结果不能授权。只导出声明的普通单链接文件，拒绝绝对路径、`..`、父目录/文件 symlink、hardlink、特殊文件及超量内容。导出之前确认所有受管执行已停止，不执行或解包候选内容。
- 评分另建 VM，用同一 `runRestricted` 执行安全导出的产物。host 比较实际观察到的 stdout/退出码与 host 留存的固定规则/隐藏预期；候选写出的 `measurement.json`、公开测试或 PASS 日志都没有评分权限。更复杂 grader 在 #21 中同样不能执行拥有宿主权限的不可信代码。

低层边界返回执行/终止事实，正式 trial 是否有效、批次是否继续由 #21 的可信 runner 根据已固定计划判断。`probe.mjs` 示范一旦边界/资产/终止不确定就停止剩余场景并保留 NOT_RUN。被阻断的越界企图和实际越界是不同事实。

## 范围和一手资料

这是该 CLI/image/kernel/入口与合成 fixture 的行为证据，不证明产品正式 eval、真实模型预算、总体安全、macOS 原生工具兼容性或日用接受。受限 workload 是 Linux arm64 Node；macOS 特有工具须另行选择案例。UID、目录、环境清理和 hash 都只是配置/证据的一部分，权限由 VM/Linux 边界实施。

CPU、内存、nproc、nofile、单文件大小、时间及输出有界；没有宣称全宿主磁盘配额或抵抗未知内核/虚拟化漏洞。宿主 runner、容器服务、预制 image、kernel 与用户同权限下的外部操作者属于可信基底。OS、kernel、CLI、策略或依赖变更必须重新验证。

- [Apple container 1.4.1 technical overview](https://github.com/apple/container/blob/1.4.1/docs/technical-overview.md)：每个容器的 VM 边界。
- [1.4.1 CLI reference](https://github.com/apple/container/blob/1.4.1/docs/command-reference.md) 与实际 `--help`：本机发布工件缺少文档所列 `commit` 子命令，因此使用标准 Containerfile build。
- [1.4.1 RuntimeService](https://github.com/apple/container/blob/1.4.1/Sources/Services/RuntimeLinux/Server/RuntimeService.swift)：stop 的 VM shutdown 路径；仍用真实残留探查与删除读回验证。
- [unshare](https://man7.org/linux/man-pages/man1/unshare.1.html)、[setpriv](https://man7.org/linux/man-pages/man1/setpriv.1.html)、[libseccomp rule API](https://github.com/seccomp/libseccomp/blob/v2.5.4/doc/man/man3/seccomp_rule_add.3)：namespace、capability/no_new_privs 与内核 filter 配置。

# #12 受限执行与可信评分探查

2026-10-09。本票路径已实现并通过实际 macOS arm64 探查；仅证明下列固定工件与合成案例。**产品正式 eval 仍待 #21 接线和重验**，未调用付费模型、未更改规格、未更换 Pi core、未 push/建 PR/关票。

## 验收结果

| #12 验收项 | 结果与证据 |
| --- | --- |
| 一种现成机制与完整路径 | PASS。Apple container 每 trial 独立 VM；Node 输入→执行→停止/删除确认→普通文件导出→另一 VM 内运行产物→host 固定规则比较→JSON/Markdown 报告。 |
| 实际越界探查 | PASS。宿主 HOME 的合成凭据 canary、其他 trial 历史、原 fixture、grader/hidden expected、报告、共享 Git 读写不可达；只读依赖/输入/策略不可写；宿主专用 sentinel 进程、Unix 控制 socket、IPv4/6、VSOCK、netlink、packet 与 namespace/process syscall 均阻断。没有读取真实用户密钥。 |
| 可信评分与导出 | PASS。执行与 detached 后代策略一致；停止后 heartbeat 不再增长。公开测试被改为 PASS 不参与评分。另一个产物伪造 `measurement.json` 并打印 PASS，可信宿主仍据实际 stdout 判 FAIL。symlink、父目录链接、hardlink、路径越界拒绝导出。 |
| 宿主模型中介 | PASS。全探查只有一次宿主确定性替身请求；guest 无宿主凭据变量。只接受固定 JSON 协议与已声明次数/输出上限，携带 URL 的额外字段在调用回调前拒绝。没有常驻模型代理。 |
| 失败关闭/首败/残留 | PASS。不可用 CLI 不启动候选、不退 shell；伪造停止记录不能导出。真实 VM 的 stop 故障测试观察到 heartbeat 从 37 增到 41 字节，结果保留 `invalid/termination_unconfirmed`，导出拒绝；测试随后用真实控制器停止、删除并读回不存在。任何边界失败使后续场景 NOT_RUN。首败与修正记录见下表。 |
| 限定声明与复用 | PASS。全部源文件集中 `scripts/isolation/`；无 package/lock/tsconfig/runtime core 修改。未创建第二套 agent loop。#21 接线义务及限制见 [README](../../../../scripts/isolation/README.md)。 |

最终实际探查的五个场景为 `good`、`bad-score`、`timeout`、`bad-model`、`symlink`。执行/后代每组含 38 个负向操作；评分侧另含 23 个。计数描述已有独立失效方式，不是测试数量配额。`good` 的可信评分为 PASS；`bad-score` 的可信评分为 FAIL，而“正确拒绝伪造评分”的场景验收为 PASS。超时与链接拒绝保留原始失败/无效语义。

## 实际版本和身份

| 工件 | 本次身份 |
| --- | --- |
| 宿主 | macOS 27.2 / 26B5101f、arm64；宿主 Node v26.8.2 |
| Apple container | Homebrew 1.4.1；实际 `--version` 的 build 为 release、commit 为 unspeci；没有把源码 tag 当成构建 commit 证明 |
| CLI 二进制 SHA256 | `dbb87a943a8574b40ad721a94fd83ca32fdbe9098b9ff3a1acbc9f2e9137ce6b` |
| guest | Linux `6.18.35`、aarch64；Node v24.8.0、util-linux `2.38.1-5+deb12u3`、libseccomp2 `2.5.4-1+deb12u1`、python3 `3.11.2-1+b1` |
| kernel 文件 SHA256 | `fb2cfb79eb1ae19447a85d75682d7fa5cfec97e24beb2609a492b806e8072c8d` |
| kernel 来源 | Kata 3.32.0 arm64 archive，安装器声明 archive SHA256 `8736c054d9223974735394f822000823baef509e1c33405ec798240fa9b6e4b5` |
| vminit | `ghcr.io/apple/containerization/vminit:0.45.0` |
| base image index | `sha256:cadbfafeb6baf87eaaffa40b3640209c4b7fd38cebde65059d15bc39cd636b85` |
| 被验证 image index | `sha256:998e7dbfb5f4f7abfb8ada97a6706bb6fe0f0a1b98a789873b4d2b6a7b78f62b` |
| arm64 image manifest | `sha256:2f3cbd08a441497348270c188607c3e5e5d5f4499384e833399346a74006bc66` |
| 保存的 OCI tar SHA256 | `120137872998cb03a5dd6e5cdf99fbbce3ca11c3eea8e503303cf7d5b9154d85`；96,681,984 bytes |

固定入口：只读 rootfs + `/input` 与 `/boundary` 只读挂载 + 独占 `/work`；无 SSH/socket/port 转发。`unshare --net` 后用 `setpriv` 降为 UID/GID 1000，清空全部 capability 与 groups，设 no_new_privs，再加载固定 libseccomp 规则。guest 实测 CapInh/Prm/Eff/Bnd/Amb 全 0、NoNewPrivs=1、Seccomp=2，仅有 loopback。VM 的外围默认网络仍存在，但候选及后代不可创建相应 socket，也不能访问 VM vsock。

配置含 1 CPU、512 MiB、nproc 64、nofile 128、单文件 8 MiB、外层墙钟时限及输出限制；导出总量上限 1 MiB。不是全宿主磁盘配额，也不是未知 kernel/VM 漏洞防护的证明。

## 首败与修正（原始文件不覆盖）

详细证据根：`/Users/nineofour/pi-durio-v1-run/evidence/issue-12/`。

| 原始记录 | 首次事实 | 后续修正/验证 |
| --- | --- | --- |
| `first-failure-export.log` | TDD red：导出模块尚不存在 | `green-export.log`：普通文件可导出，链接/越界拒绝 |
| `first-failure-boundary.log` | TDD red：执行边界模块尚不存在 | `green-local.log`：fail-closed 与伪造停止记录拒绝；真实测试 SKIP 明确保留 |
| `real-boundary-01.log` | 未注册的 digest reference 在本机 image store 不可取得 | 显式 image tag 注册 digest，且实现核对 metadata/config digest；`real-boundary-02.log` 真实路径 PASS |
| `probe-01/` | 探查将 guest 自身 PID 1 当成外层控制进程，self-access 成功因此整批 invalid，后续 NOT_RUN | 不将 self-access 算宿主越界；改测真实宿主 sentinel 与 ptrace/process_vm 通道，保留 guest init 身份 |
| `probe-02/` | 样例模型响应已返回，但样例 stdin 保持活动导致 timeout；执行失败保留 | 样例完成单次中介后关闭 stdin；`probe-03/` 全场景 PASS |
| `tests-final-01.log`、`control-hang-first.json` | stop 故障包装器的 helper 持有管道，杀 client 后等待 EOF 卡住清理；由可信操作者仅停止该测试 VM 释放等待，本次不计通过 | halt 先关闭自有输出管道，清理独立进行；`tests-final-02.log` 5/5 PASS，真实残留故障和拒绝导出路径得到验证 |
| `research/commit-image.log` | 官方发布文档列出的 `container commit` 在本机 1.4.1 CLI 不存在 | 未更改依赖核心，改用标准 Containerfile build；记录此文档/发布工件差异 |

`probe-final-02/` 是修正后最终代码和清理后环境的完整路径证据；`verification.json` 是其报告副本。`tests-final-03.log` 包括实际并发模型请求的次数限制，以及在途未完成请求在取消后保留 unknown。每次 run 还保存 plan、创建参数、image metadata、配置、停止/删除/absence 读回、outcome、导出清单及各阶段实际产物。真实残留测试详细目录之一为 `durio-stop-failure-VtvMyu/`，其 `cleanup.json` 确认测试结束后残留已清除。

## 依赖体积与清理

首次准备未指定平台，下载了 Node 的多架构内容，又创建了准备容器与 builder。这个探索开销保留在日志中，没有用清理后的数字替代历史。`storage-before-cleanup.json` 的已观测 appRoot 分配量为 **18,336,559,104 bytes（约 17.08 GiB）**，表观文件大小 6,063,865,845,385 bytes；这只是已观测快照，不保证捕捉绝对峰值。

仅清理本票创建的三个准备容器、builder 与多架构 base 引用。最终容器列表为空，被验证的 digest image 仍可 inspect，且已额外保存完整 OCI tar 和 kernel 文件。清理后 appRoot 的文件分配量为 **3,405,303,808 bytes（约 3.17 GiB）**，表观大小 **1,102,631,913,091 bytes**。巨大表观值来自稀疏 VM 磁盘；APFS 克隆共享区块可能被各文件重复计数，所以这不是唯一物理 extents 的精确总量。

CLI 安装目录另有 429,879,296 allocated bytes（约 410 MiB）；证据副本中的 OCI tar 96,681,984 bytes 与 kernel 30,423,552 bytes 单列，不属于 npm 产品代码。保留 snapshot/cache 及容器基础设施的成本应进入 #31 的安装/分发体积测量；本票不据此认定产品已“轻量”。

## #21 的剩余义务

真实 TUI/headless 共用 runtime 尚未接入此 Linux 入口；#21 须将 runtime、工具与候选代码整体放入受限侧，按实际 runtime 重跑评分/越界/后代/导出检查。当前宿主 callback 只证明无密钥泄露的确定性请求接缝，不能证明付费 provider、持久预算、内部重试/compaction 计量或取消退款。旧本机报告不自动授权正式 trial，也不外推到普通可信本机 coding。

OS、kernel、CLI、依赖/策略变化需要重新验证。宿主 runner、容器服务、固定 image/kernel 和用户同权限下的外部操作者属于可信基底；不承诺抵御宿主主动篡改或未知虚拟化漏洞。用户验收、真实 Terminal、付费模型、发布及关票仍独立。

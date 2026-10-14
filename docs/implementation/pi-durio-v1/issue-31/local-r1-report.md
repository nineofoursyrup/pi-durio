# #31 局部本地测量：local-r1

状态：**PARTIAL / 技术验收未完成**。这些数据属于固定的旧测量候选；不会随集成分支后续修复自动改名。#30 真实模型闭环、必需的 native Terminal 测量、最终评审与 #32 用户日用接受仍未完成。

## 测量身份与环境

- 测量候选：`1be8e2826fa5d523e9224677838dd97b2d4d8ac3`。
- 产品源码生产者：`2554316e5a175299d1149d02e5bb2d8a5824beef`。
- source/build manifest SHA-256：`da7c2bca6b3c2b3dc8c23d2b96ab90977135df4f9b9d74de25642e353ff22af8`。
- npm 分发包 SHA-256：`5733c4dca3deeef7af079cae36cfa694dd5cf51d54dabb82b48ea36b41b22ca2`。
- macOS 27.2，arm64，MacBookPro18,1，32 GiB RAM，10 logical CPUs；Node v26.8.2；Terminal 2.15（本次 native 工作负载尚未运行，profile 未知）。
- 开始前 load average 为 50.89 / 32.78 / 25.99；启动样本期间约 59–62 / 38–39 / 28–29。Spotlight 与 Time Machine 在后台活动，未修改系统服务。测量时没有本任务的构建或验证 VM 并发。

## 体积与自有维护范围

统计代码按字面目录前缀分类，保留文件数、字节和 UTF-8 物理行。物理行含注释/空行，也包含多语句密集行；不等于逻辑 LOC、可维护性评分或轻量合格阈值。

| 分类 | 文件 | 字节 | 物理行 |
| --- | ---: | ---: | ---: |
| product（src） | 75 | 755,646 | 6,946 |
| tests | 34 | 403,863 | 3,714 |
| scripts | 39 | 275,006 | 2,418 |
| documentation | 180 | 2,652,862 | 25,391 |
| root config / other | 9 | 211,117 | 4,522 |
| vendor | 5 | 1,041,519 | 108 |

documentation 内另含 4 个需要维护的可执行验收 helper，共 49,237 bytes / 231 物理行；它们已在该目录汇总中计入，不能漏算，也不能重复相加。原始 HTML、配置、vendor patch、归档和生成文件的边界见 [机器可读数据](local-r1-summary.json)。

分发 `.tgz` 为 **19,189,996 bytes**；包内普通文件解包逻辑字节 **89,958,444**。独立安装包含 12,906 普通文件与 5 symlink，逻辑字节 **90,024,769**，按路径统计分配字节 **128,589,824**（不声称 APFS 唯一物理占用）。Node 可执行文件未计入；6 个跨平台 native `.node` 文件以及原始/派生 Pi TUI archive 均计入。安装命令实际为 `npm install --ignore-scripts --no-audit --no-fund pi-durio-0.1.0.tgz`，不能冒称使用了 `--omit=dev`。安装 lock 中 99 个 package entries 无 dev flag；TypeScript 与 `@types/proper-lockfile` 不在安装中，`@types/node` 是 protobufjs 的生产传递依赖，已计入。源码根开发依赖的独立副本不计入该安装。

## 两条进程启动路径

每条路径连续运行 7 次新 Node 进程，无 provider/runtime task，全部 exit 0。没有清除文件系统缓存，因此仅称 **process-cold**，不是整机冷启动、首个可用 TUI frame 或模型延迟。缺失数据根的 history 结果保留 missing-source coverage，不能当作已初始化数据库查询；数据根始终没有被创建。

| 路径 | 最小 ms | 中位 ms | 最大 ms | 首次 ms |
| --- | ---: | ---: | ---: | ---: |
| CLI help | 205.006 | 207.9145 | 362.465 | 241.458 |
| missing-store history | 201.416 | 207.3485 | 209.752 | 201.416 |

help 全部样本：241.458417、362.465333、284.791、207.9145、205.00625、205.288375、205.9475 ms。history 全部样本：201.416458、208.259667、202.229041、205.791334、209.752416、207.348541、208.5715 ms。后台负载明显，保留全部数据，未挑选最快一次作为代表值。

## 未取得与候选适用性

Native 首帧/空闲 RSS、至少五分钟 60 轮长会话 RSS/记录增长、native 1 MiB 输出后继续输入、保留数据上的写盘/查询/完整导出，以及 native compact/improve/报告组合均 **NOT RUN**。已冻结用户启动脚本，但 Computer Use 工具拒绝控制 Terminal，未尝试其他桌面控制通道绕过限制。此前 #16/#17 的人工 Terminal 证据保留原范围，不能扩展为这些新测量。

真实 coding/eval/improve/维护 provider 用量与费用 **NOT RUN / UNKNOWN**，实际付费调用 0。#32 仍需用户在自己的 Mac 上试用并明确接受。

该候选的独立 Spec 评审另复现 preflight 全量载入历史输出导致内存随历史增长的问题（E2），正在修复。评审的低 heap Evidence seam 是缺陷证据，不是上述 native 长会话 RSS 测量。旧包体积与启动样本作为原始记录保留；任何后续候选需要明确决定哪些数据适用、哪些需重测，不能据本报告宣称最终技术验收或 E2 通过。

## 原始证据

外部不可变批次目录：`/Users/nineofour/pi-durio-v1-run/evidence/issue-31/local-r1/`。完整路径和内容哈希见 [evidence-index.json](evidence-index.json)，关键派生摘要见 [local-r1-summary.json](local-r1-summary.json)。原始 inventory、14 次 stdout/stderr/result、冻结工作负载和环境观察均保留；本仓库报告没有删除或改写原始文件。

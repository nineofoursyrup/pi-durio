# #13：可写 coding、工作区所有权与完整输出

范围为 `PI-DURIO-V1-TICKETS-r1:T03`。使用现有共用 runtime 和精确 `@earendil-works/pi-durable@1.1.0` 的公开 Harness、tools、ExecutionEnv；未更换依赖、复制工具算法、重写调度/恢复循环或使用 demo 私有导入。上游四工具 replay 默认仍为 unsafe。本票本地接线验收通过，真实 provider、完整恢复及首版验收分别保留。

## 可运行接口

- `runCodingTask(options)` 接受 `ReadTaskOptions` 加可选 `toolEnvironment: { version, variables }`，显式授予本次已声明 coding 任务 read/write/edit/bash。`runReadTask` 仍只安装 read，保持 signal/cancellation/onObservation、既有结果及只读查询兼容。CLI `run --coding` 接到同一入口，`--tool-env-config PATH` 只允许 coding 使用。
- 文件工具限于声明项目的真实路径，拒绝向项目外 symlink 写入；256 KiB 文件、32 KiB 输入、8 个 provider attempt 的小任务限制保留。替换现有文件前要求已读取，保存前像与新内容，检测观察后的修改与删除；未被本任务改动的用户材料不重置。公开 `settings.toolExecution: 'sequential'` 使 coding 同轮文件和 shell 调用依次执行。外部编辑器不遵守本产品锁，读取/写入不是 OS 原子 compare-and-swap；不承诺自动回滚。
- bash 采用可信本机执行，具有当前用户可用的本机文件、进程和网络权限，不是 OS 沙箱。固定工具集合、环境方法及写入目标检查不能被模型/材料增加；shell 本身属于用户显式授权的能力，语义任务范围仍以受理时的用户请求为准，不声称解析任意 shell 就能证明任务范围。
- 默认工具环境仅有 `PATH/HOME/TMPDIR/LANG`，其中 PATH 包括当前 Node 所在目录和常用本机构建路径；使用 `/bin/bash`。`inheritEnv: false` 在公开 prepare 和 ExecutionEnv.exec 两处落实，实际 exec 强制使用受理时复制的配置。额外变量必须显式配置；配置/执行记录只写变量名及版本，不主动封存值。可信本机 shell 仍可访问当前用户有权读取的其他凭据来源，不构成绝对凭据隔离。

## 工作区与生命周期

用户级固定 registry 位于 `~/Library/Application Support/pi-durio/workspace-owners`，不随 data root/session 改变。先解析真实路径和 Git top-level；只有 Git 明确确认不是仓库才采用声明非 Git 根，损坏、权限、超时等不确定失败以 `WORKSPACE_IDENTITY_UNKNOWN` 阻断。由 Git 子目录启动时，数据根也必须在整个 Git 项目外，拒绝配置不先创建项目内目录。

registry 互斥登记与 per-root 成熟 heartbeat owner 联合检查活动根；别名、Git 子目录及登记的父子/重叠非 Git 根不能成为第二写入者。冲突发生在 Evidence/可写 storage/Harness 受理之前，报告 holder 和人工核对指引。新调用必须先取得目标工作区 owner；本票没有工作区热切换界面。陈旧锁不按 PID 消失或超时自动夺取；协议不隔离外部编辑器、不同 worktree 的共享 Git 元数据或外部服务。

退出沿 #11 公开取消/关闭路径；shell 原文写入回调失败由上游 NodeExecutionEnv 杀死其受管命令，宿主停止新请求/工具，并等待已启动 exec 的公开结果。`executionCleanup` 追加 started/settled 计数，只有所有受管 exec 返回、存储关闭确认后才释放 owner；未对齐则 cleanup/status unknown，保留锁。`externalProcesses: 'unknown'` 明确保留其他/逃逸后代进程的不确定性，不将 Harness.close 或单独 PID 检查当成所有外部副作用停止证明。

## 原文与只读查询

ExecutionEnv.exec 去掉上游可省略输出的 window，在 `onOutput` 保存所有**实际取得、按各自流解码的 UTF-8 文本**。记录界面边界，不声称取得解码前非法字节。每块至多 16 KiB，原记录沿用内容寻址对象、fsync 和 SQLite append；同步写入形成背压，没有不断增长的输出/telemetry 队列。上游工具仍保留有界显示/送模尾部和临时 spill；长期档案不依赖 spill。

新记录不改变 `records` schema、BlobRef、openHostReadonly 或 readRun：

| kind | 内容及归属 |
| --- | --- |
| `workspace.owner` | 规范根、声明工作区及协议限制 |
| `read.text`、`file.write-intent/result` | edit 实际取得文本、写前/后内容和结果；关联 toolAttempt |
| `shell.started` | 命令、cwd、环境名称及采集边界；关联 toolAttempt |
| `tool.output` | `{toolAttempt, acquired:{index, offset, stream, encoding:'base64', bytes}}`；index/offset 为该 shell 的合并到达顺序，按 stream 可分别重建 |
| `shell.completed` | 已保存 bytes/chunks、完整/partial、退出码或执行错误、受管命令返回及 externalProcesses unknown |
| `evidence.gap` | 原文保存失败的 kind/原因和 unknown 完整性；仅在仍能写下时追加，不重跑补造 |
| `tool.diagnostic` | 从上游 API 取得的完整诊断，关联原 tool attempt |
| `tool.summary` | 可重建派生摘要，UTF-8 JSON 总长至多 3072 bytes；原文成功保存后才追加 |

`tool.summary.data` 为 `{attemptId, tool, isError, resultSeq?, errorSeq?, diagnostics, diagnosticsOmitted, truncation}`。resultSeq/errorSeq 指向相同 run 内已保存的原始记录；错误依据 execute 结果/异常，不从正文推断。诊断初始最多 8 条、单条 message 256 字符/code 128 字符，再按总字节裁剪；truncation 仅转发上游已取得且不超 1024 bytes 的元数据，否则 null。摘要保存/派生观察异常只令 observation degraded，不改变原结果、不重跑。read 路径也产生摘要。缺摘要或缺元数据应呈现 unknown。

原文失败先取消放行并受控停止；实际产物和已保存前缀保留，未能保存的内容保持缺口。shell 非零检查是实际失败证据，即使随后模型正常结束 run，也不能将 completed 当验收通过。所有重开仍纯查询，不调用 Harness、不新增工具/provider attempt 或费用；旧 pending/unknown 仍由 #11 preflight 阻断，等待 #15 的恢复核对能力。

## 验证与复现

源码命令：`npm ci`、`npm run check`。独立演示：`node scripts/demo-coding.mjs /absolute/evidence/directory`。演示创建自身 fixture，不修改既有业务项目；它使用 `pi-durio/offline` 的显式 scriptedTransport，仅控制 provider 响应，Harness、provider 适配、工具、SQLite、文件及 shell 都真实执行，验收由实际产物/独立检查/hash 判定。

外部证据根为 `/Users/nineofour/pi-durio-v1-run/evidence/issue-13/`。候选、逐项日志与最终演示路径见 [validation.json](validation.json)；首败与修复链见 [first-failures.md](first-failures.md)。行为覆盖真实四工具小修复、用户文件保护、显式环境及凭据不继承、同轮编辑、别名跨进程冲突/Git sibling/非 Git 重叠、身份未知拒绝、Git 子目录数据根拒绝、正常/非零/取消/写盘失败输出、纯查询、派生摘要降级及 #11 全部回归。

独立演示保存原始减法 bug 和首次 baseline 检查失败；修复后独立 Node 检查退出 0。8 MiB + 10 bytes 输出按 16 KiB 上限分块，删掉上游 spill 后独立进程逐页 SHA-256 重开一致；第二次送模请求约 55 KiB。该样本 RSS 仅作观察，没有将其宣称完整性能报告。真实文件系统 ENOTDIR 故障保留 partial 输出、gap、unknown run、一次启动/一次 provider 调用及已发生写入；在公开 exec 已返回后，独立核验 PID 不存在且产物停止增长，没有用延时单独推导终止。

一手 API 来源：[精确构建的 ExecutionEnv](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/env/index.ts)、[公开 bash 工具](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/tools/bash.ts)。已对照本次实际 npm 1.1.0 发布包的 dist 定义及 NodeExecutionEnv 实现。

## 未覆盖职责

真实 DeepSeek 推理/有效认证/计费 **NOT RUN**；无付费授权。TUI/macOS Terminal 归 #16，完整停止退出交互归 #14，跨进程续跑/恢复核对与旧 pending 处置归 #15。多任务/长会话/compaction、正式 eval、improve、完整轻量测量及首版日用接受没有在本票完成。没有 main 合并、发布、关票或远程写回。

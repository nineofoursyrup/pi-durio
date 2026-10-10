# SPEC-01：启动检查与恢复 host 事实读取的有界修复

本次修复基于集成 `54a8c22aba4a5a62fac0b3c88ff8db292bd30760`，处理固定评审候选 `1be8e2826fa5d523e9224677838dd97b2d4d8ac3` 的 SPEC-01。原问题和协调补充首败保留在 `/Users/nineofour/pi-durio-v1-run/review/1be8e282/`。修复证据追加于 `/Users/nineofour/pi-durio-v1-run/evidence/repair-15-preflight/`，不覆盖原报告、OOM 或历史任务事实。

## 行为与边界

- 新任务 admission 只逐条读取必要的接受、关闭、恢复、compaction 和清理事实。必要事实的缺失、损坏和未确认关闭仍阻断；历史 `tool.output` 等无关原文由现有历史查询报告取得状态，不为启动检查装入内存。
- admission 用共享的 owner-fenced main/WAL 副本检查，按每页 32 条扫描完整 task/submission 集合后丢弃页面；不读取 transcript、agent、live、usage 正文。所有页都参与判定，末页 pending 不被截断。
- 跨 session 的接受身份与核对结果存入临时 SQLite 最小索引，页缓存目标为 2 MiB；不复制原文或 host 事实库，`finally` 删除临时目录。目录流式枚举，返回固定大小的 session 计数、host watermark，以及调用方可选指定 run 的单份 pending 摘要。runtime 的续接/compaction 冻结检查仍使用这份摘要。
- 已管理的 session 缺失仍核对完整 preview、commit、part/file results、实际 plan 内容、原关闭、移除标记和后续控制事实。读取逐条进行，不收集整个 host 历史；既有 16 MiB plan 上限仍适用。
- `recoveryRecords` 改为固定 watermark 的惰性只读视图。`find`、`findLast`、`some`、`filter` 和迭代不缓存整个历史；仅选中并访问 `data` 时校验原 body。恢复 snapshot 的 JSON 原字节顺序与 SHA256 算法保持不变，逐条读取、校验和哈希全部事实；被排除出 snapshot 内容的 recovery report 仍检查原文完整性。owner snapshot 同样保留原身份算法和完整性检查。
- `inspectSession` 完整读取接口继续服务目标 session 的恢复/存储管理，未伪装成有界接口。恢复检查的其他 session 已使用 admission 摘要。

没有新增 agent loop、恢复调度器、durable 私有 SQL 或 provider 调用。

## 验证

`build-green-07.log` 构建通过；`affected-07.log` 记录 7 个受影响测试文件 60/60 通过：`preflight`、`recovery-facts`、`recovery`、`runtime`、`storage`、`control`、`compaction`。

新增回归使用独立进程的 24 MiB V8 heap 约束，覆盖 24 MiB 历史输出，以及 4 个 session 共 32 MiB transcript；这只是暴露整批物化的确定性机制，不是产品 RSS 验收阈值。另验证跨页 task/submission pending、必要接受/关闭原文缺损、固定 watermark、旧新 snapshot digest 逐字节相等、被排除出内容哈希的 recovery report 损坏仍拒绝核对。

原 `first-red-01.log` 保留真实 heap OOM；build 日志另保留消费者接口适配与测试 fixture 公共类型错误。协调的独立 `recoveryRecords` 首次 OOM 仍在 `review/1be8e282/coordinator-recovery-scope/`。依赖是从主 checkout 的既有 `node_modules` 离线复制，未修改共享安装。

全项目 `npm check` 留给协调在组合候选上统一执行；未执行 VM、原生 Terminal、真实 provider/付费请求。本轮通过只支持以上 host/admission 路径，不表示整个 E2 或首版接受完成。

## 后续目标 session 恢复边界

`inspectOwnedRecovery` 的目标 session 仍使用完整 `inspectSession`，后者累积所有 entries/tasks/submissions/conversations/documents；`RecoveryReport.tools` 也枚举完整工具历史。transcript 或已提交任务持续增长时，该路径的驻留集合仍随历史增长。`retentionState`、`storage-archive` 的完整 session 检查，以及 runtime 的特定 compaction withdrawal/关闭核对，也仍使用完整接口。

最小后续方案应保留源文件 owner/hash fencing，改为专用恢复扫描：用公开 `scanTasks`/`scanSubmissions` 分页核对全部归属；对工具仅用公开 `entry(assistantId)`/`entry(outcome.entryId)` 读取所需关联，仅读目标 conversation 的 `pi.agent`/`pi.live`；必要的跨页关联可使用临时最小索引。已提交工具历史用计数和分页呈现，而待决工具、resolutions、未知费用及快照覆盖必须完整；不能用任意截断形成“无未知”结论。该变化涉及恢复报告/决定接口，应单独固定候选与回归证据后推进，不把本次 60 项通过当作该路径已修复。

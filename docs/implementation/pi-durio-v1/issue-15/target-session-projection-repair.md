# Target session、关闭和管理投影修复

本阶段接续 `preflight-memory-repair.md`。首次实现的完整 `inspectSession` 已移除；runtime 的恢复、关闭、压缩撤回、存储保护和归档消费者及相关测试均改为按用途读取公开 Storage。没有修改上游 schema、创建第二套调度状态机或更换 Pi。

`inspectSnapshot` 沿用 data-root owner、路径约束、quiescent main/WAL 副本、源文件集合/前后 hashes 与 finally 关闭/清理。callback 只得到公开只读方法，不能访问 Harness。任务与提交以 32 项页扫描；恢复只按实际工具的 assistant/outcome ID 读取 Entry，目标 conversation 单独读 `pi.agent`/`pi.live`。跨页身份连接使用只含必要 ID、seq 与分类的临时 SQLite，关闭后删除。其他 session 的目录名也落临时索引排序，避免名称数组增长或分页顺序漂移。

恢复报告的 `tools`、`compactions`、`unknownModelAttempts`、`reasons` 和 `session.pending` 是最多 32 项的显示页；`details` 提供完整计数、完整投影摘要 hash、offset 与 next。`session.pendingCount` 是所有任务和提交的完整 pending 计数。`details.toolCounts` 与 `details.unresolvedTools` 来自完整扫描。提交决定时再完整核对；未知工具、旧 resolution、stop intent、foreign task/submission、未知成本、兼容性检查与能力限制均不依赖当前显示页。完整原因的 count/hash 绑定到 `snapshotId`，遗漏的阻断原因仍阻断 continue/end。

```sh
pi-durio recover --inspect --run RUN --data-root ROOT --authorization AUTH.json
pi-durio recover --inspect --run RUN --data-root ROOT --authorization AUTH.json --after 32 --limit 32 --snapshot SNAPSHOT
pi-durio recover --inspect --run RUN --data-root ROOT --authorization AUTH.json --snapshot SNAPSHOT --evidence ENTRY_ID --offset 0 --limit 4096
pi-durio recover --inspect --run RUN --data-root ROOT --authorization AUTH.json --snapshot SNAPSHOT --evidence task:TASK_ID --offset 0 --limit 4096
```

后续页必须提供同一 snapshot；变化时明确拒绝。`readRecoveryDetail` 重新验证整个恢复身份及源文件，再按公开 Entry/Task ID 读取原文 JSON，以 UTF-16 code-unit offset 分页，返回全文 hash/bytes、当前 text 与 next。大参数在报告中仅展示稳定 Entry 或 Task checkpoint 引用；它们的原文没有删改。TUI 恢复面板显示完整计数，`n`/`p` 翻页，或使用 `/recover RUN OFFSET SNAPSHOT`。当前页生成的 `/decide` 模板明确只含可见项；只决定这些项不能绕过其他未知。

普通 confirmed close 不再复制 transcript。它扫描完整状态，将每个 conversation 的 `pi.usage` 投影暂存磁盘，最终 source fence 成功后按文档写入有界 `durable.closed-snapshot` receipt，再写计数摘要。receipt 明确是投影、包含完整 sourceFiles，原文仍在 durable 与原宿主证据。runtime 沿用第一份 usage 的取值规则；全部 usage 文档仍按既有 session/conversation 身份交给 `queryUsage` 覆写累计投影，重复读取不重加。末次摘要中的空 usage 数组不清除先前文档。

压缩撤回只读取对应 task/outcome/summary submission 的公开 ID。存储保护及归档逐页验证全部 retained Entry 和既有文档族可读性，保留 pending/未知格式/缺坏内容的 fail-closed 语义。清理计划沿用有限管理边界，并在 session 投影累计超过 16 MiB 时拒绝；归档报告只显示有限摘要，完整文件与 session 路径仍由校验过的 archive manifest 和还原后的公共 Storage 提供。

新增回归覆盖真实 offline Pi 源 session 的 64 MiB 原文在 48 MiB heap 下核对、普通关闭超过旧 2 MiB snapshot 边界、两份 conversation usage 的归属和重复读取、40 个未知工具的跨页决定完整性、末页 foreign task/submission、缺失及结构错误的 assistant/outcome、过期 snapshot、stop intent，以及实际 CLI/TUI 翻页。首败、精确 source/build/fixture 身份和实际测试结果保留在 `/Users/nineofour/pi-durio-v1-run/evidence/repair-15-target-session/`。这些是定向离线回归；组合 candidate 的完整 check 与独立 re-review 由协调者另行完成，不据此宣布 SPEC-01/STD-01 或 #15 已重新验收。

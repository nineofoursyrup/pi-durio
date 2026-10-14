# Fresh #15 后续阶段接手边界

已固定第一阶段：commit 5ab40019d56eaf4e36c64d30cb3ebc84d20be072，manifest f858ca393a4973afc2938dbda57356be214e2213ce38eba5911dac590409e9da。请从协调给出的组合 tip 开始，保留这里和旧 candidate 的失败/通过证据，不复写。

## 已解决的接缝

- ordinary preflight：host 分类逐条读取；opendir；durable task/submission 页；临时最小 SQLite identity join；结果只含计数/单个目标 pending。
- recoveryRecords：固定 watermark 惰性视图，data 按需验证；恢复 snapshot 逐条读原文/哈希，算法与旧候选一致。
- recovery 的其他 session：不再 full inspector 读全部 transcript，但外围 readdir 的名字数组、reasons 数组仍不是无限历史的完整分页报告合同。

## 明确剩余调用点

1. `src/recovery.ts:93 inspectOwnedRecovery -> inspectSession`：目标 session 仍保留全部 entries/tasks/submissions/conversations/agents/live/usage；对每个 pi.tool 还需按 assistant/outcome entry 核对；`tools`、`unknownModelAttempts`、compact/steer identity 集合依赖完整历史。不能只砍报告数组或保留最新 N 条，否则会隐藏未处置工作。
2. `src/runtime.ts:765`：不是仅异常恢复路径。每个 `cleanup === 'confirmed'` 且 evidence/sessionOwner 存在的收尾都会 full inspectSession；只使用第一份 pi.usage，然后 `record('durable.closed-snapshot', snapshot)` 保存整个快照。由源码可推出：增长的 transcript 会增长驻留集合，并可能令 2 MiB `Evidence.append` 上限触发，将原结果设为 unknown。这项限额后果尚未独立复现，不应写成已测事实。
3. `src/runtime.ts:257`：compaction withdrawal 只需要特定 compaction task 的 outcome、关联 summary submission 与 sourceFiles；当前仍full读取。
4. `src/retention.ts:104 retentionState`：需要 conversation IDs、task/submission/pending counts、sourceFiles。其 plan/事实有现有数量/16 MiB 边界，不能通过忽略缺坏保护原文放行清理。
5. `src/storage-archive.ts:36 verifyReadable`：需要 conversation存在、counts、pending；当前逐 session full读取并累计session摘要。必须保留完整档案依赖校验与未知格式失败语义。

## 公共 API 最小方向

保留 `inspectSnapshot` 的 owner/path/main+WAL/hash fencing 和 finally cleanup；可在受限 callback 生命周期中提供公共 Storage，把不同用途的读取投影放在对应函数，禁止原始 Harness 或可调度对象逃逸。

- `scanTasks` / `scanSubmissions` 分页检查所有 task/submission 的归属与状态。跨页 joins 必要时使用临时最小 SQLite 索引，固定页/缓存并清理。
- 对当前恢复工具，只 `entry(task.input.assistant)` 与 `entry(outcome.result.entryId)`；不要 scanEntries 收集整份 transcript。
- 仅目标 conversation 取 `findDocument(pi.agent/pi.live)` + `document`；结束计量按既有 pi.usage 归属规则保留，不能为省内存改累计值或重复计量。
- `durable.closed-snapshot` 应记录它的事实用途所需摘要/稳定引用，而非复制完整原文；原文仍在 durable 与原 host evidence，不能把摘要称原文。
- 恢复报告为已提交历史提供摘要/分页；待决工具、未知成本、用户 resolutions 和 snapshot身份必须全覆盖。可先给 bounded报告投影与完整磁盘核对结果绑定，不能任意truncate后当成无unknown。

## 必要行为验证建议

- 真实公共 Storage fixture 的目标 session 长 transcript（单 session也需覆盖），在受限heap执行 inspectRecovery并与正常小fixture比较；其accepted/submission/agent/版本事实必须来自真实offline run或完整明确fixture，不用私有表造出“正常”结论。
- 普通confirmed close验证完整输出保留、usage值相同、durable.closed-snapshot正文不随无关历史增长，超过旧2MiB接缝仍有真实任务结果；首先保留实际首败，区别其他更早2MiB body上限。
- 末页foreign task/submission、缺坏assistant/outcome、未知工具派发、stop intent、ended source漂移、resolution遗漏/过期snapshot都不能被摘要绕过。
- storage清理/归档与specific compaction withdrawal复用现有实际测试；只有新接口/行为触及时重跑。全项目check由协调统一组合candidate跑，不为阶段切换重复确定性结果。

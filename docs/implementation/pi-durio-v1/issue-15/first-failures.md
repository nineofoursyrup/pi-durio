# #15 首败链

日志都追加保留于 `/Users/nineofour/pi-durio-v1-run/evidence/issue-15/`，不覆盖原日志或任务事实。

- `first-red-01.log`：预期 red，尚无 inspectRecovery 导出。
- `build-01.log`：实现首次编译失败；公开 `Storage.scanEntries` 必须给 conversationId。改为逐公开 conversation 分页扫描，没有查询私有表。
- `first-red-02.log`：继续/决定纵向接缝尚不存在；保留该次 red 与当时已有的编译错误。
- `build-02.log`：TypeScript 的 outcome narrowing、品牌化 SubmissionId 和 unknown result 断言错误；按真实公开类型修正。
- `recovery-03.log`：实际正向行为已执行，两个断言因持久 JSON 正常省略 undefined 字段而失败；比较持久 JSON 语义，未改业务结果或来源数据。`recovery-04.log` 随后 4/4 通过。
- `build-05.log`：空 reports 数组在提前 return 路径推断失败，补精确公开 inspection 返回类型。
- `build-06.log` / `build-07.log`：全 Harness fixture 对 ConversationOwnership/TaskOptions 的初次声明不符合实际 `.d.ts`；按公开 ownerless/conversation 接口修正，不绕过检查或改私有 schema。
- `recovery-08`、`recovery-09`、`recovery-10`、`recovery-11` 保存逐步新增的独立覆盖及通过结果。`check-01.log` 是当时全项目 53/53 通过，最终候选的适用检查另写新文件。
- 独立 demo 中 `after-effect` 和 `committed` 的 `retained-first-failure:*` 是刻意注入的真实 host 持久化失败。实际任务的 unknown/缺失回执、evidence.gap、已有文件效果和未知费用保留在各自原 dataRoot；随后 PASS 仅说明恢复处理符合合同，不把故障任务重写成成功。
- `check-final-01.log`：合入当时 integration 后 58 项中 57 通过，原 headless SIGINT/SIGTERM 用例在等待 `task.accepted` 时失败。`lifecycle-isolated-01.log` 单独通过，但未按 flaky 忽略；8 进程探针 `startup-probe-01.json` 复现 3 个 writer 在接受前因只读轮询持有的短暂 SQLite 锁失败。`host-lock-red-01.log` 通过跨进程显式持有 150ms readonly transaction 确定复现 `SQLITE_BUSY`。
- 修复是在 Evidence writer 设置有界 `busy_timeout=1000`，只等待 SQLite 锁，不重试 model/tool，不改原信号测试等待阈值或断言。`host-lock-green-01.log` 及 `lifecycle-lock-green-01.log` 通过。
- `startup-probe-02.json`：8/8 接受成功，但我误把探针与构建并发，2 个进程读到构建正复制中的 lock JSON 后失败；记录保留为无效验收运行，未当作产品通过。固定构建下的 `startup-probe-03.json` 8/8 接受成功，SIGINT/SIGTERM 均为预期 130/75；此后没有修改构建文件。

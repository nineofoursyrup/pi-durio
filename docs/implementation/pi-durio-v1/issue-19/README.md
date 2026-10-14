# #19 自动与主动上下文压缩

自动压缩使用固定 `@earendil-works/pi-durable@1.1.0` 的阈值/overflow 行为；主动压缩调用公开 `Conversation.compact()`、`Harness.waitForTask()` 与 summary submission。`CompactionFacts` 只观察公开提交和 `beforeCompact`，不计算 cut、不生成替代摘要、不新增 scheduler。默认开启上游 compaction，`reserveTokens=16384`、`keepRecentTokens=20000`。离线 `verificationCompaction` 仅在明确 offline transport + host provider capability 下改变阈值以验证真实路径。

## 用户入口与状态

- TUI `/compact`：活动任务中持久保存管理请求；当前完成后按独立请求顺序执行。当前 run 的 steer 仍在上游工具轮次接入。同会话等效未完成 compact 合并，别名保留，短上下文 noop 不调用模型。
- TUI 空闲 `/compact`：当前活动、完成且清理已确认的会话直接维护；`/compactions` 分页看生成、摘要、源范围和实际接入；`c` 定向取消压缩 task。历史/恢复窗口不可隐式压缩，`/queue` 可撤回具体请求。
- Headless `pi-durio compact --run RUN --id REQUEST --authorization FILE [--data-root ROOT] [--offline-demo]` 使用同一 runtime。authorization 为 `{workspace,mode,tools,toolEnvironment?}`，与源执行配置一致。`compact --inspect --run RUN` 只读，不打开 Harness。
- `control` NDJSON 的 `compact` 请求走同一 TaskControl；`cancel-compact` 带独立决定 ID、真实 compaction task ID、不可变 target，不能将取消扩大为 conversation abort。
- `run --context-run RUN` / 公共 `contextRunId` 将已提交上下文快照导入新独立任务。先校验源产物、配置、workspace、授权、完成状态及整个 Harness；不兼容时拒绝，不静默从空白开始。TUI 仅从当前活动的最终完成 run 提供它。

忙时请求的 admission target 永远不变；执行时来源沿已提交 `context.imported` / `context.snapshot` 的 follow-up 关系确定，单独记录真实源 run/session/conversation。前序失败、停止或未决时保留冻结，不能退回旧的已完成源。冻结但从未执行的 compact 可经源绑定决定明确重新接入；已派发操作必须核对它的真实 task/submission，不能重用 request ID 再派发。

## 原文、取消与恢复

`compaction.source` 固定上游实际范围、firstKept 与输入消息；`compaction.boundary` 固定持久 checkpoint 的 tail/attempt。实际 summary payload 来自 `model.intent` / `model.dispatch`，区分序列化/截断前后的材料。`compaction.task`、`compaction.generated`、`compaction.summary`、`compaction.submission`、`compaction.finished` 分开记录生成与接入；直接拥有 conversation 的 overflow compaction 以公开 committed entry 为接入事实，异步摘要以 submission placement 为准。

所有原文留存。状态包括 noop、generated、applied、stale、cancelled、failed、interrupted。长摘要显示可截断，源 blob 身份不变；压缩不清理磁盘。定向取消只用公开 `abortTask` 和未接入 summary 的 `abort`；接入先提交则显示 applied，不声称回滚。失败或不完整输出保留已取得响应和用量，另一个请求 ID 可明确重试。

退出/未知中断不唤醒旧 compaction。整个 Harness 的 task、queued summary、host compaction 闭合事实都进入 preflight/recovery 核对。中断的 summary 不通过普通 recovery 自动恢复；明确 end 隔离原会话后可新建任务。结束旧工作不把原 unknown 改写为成功，冷重开撤回先查公开持久 task/submission 的实际接入事实。

## 请求身份和费用

`completeSimple` 透过公开 `Models` 的 `streamSimple`，同一次请求只记录一次 response。固定 Pi 的实际 compaction 用途由调用路径证明；公开 Models 接口未给出其 owning durable task ID，因此请求上的该字段仍为 null，不猜测关联。自动 compaction 归触发 task；手动请求的 scope 为 `maintenance:REQUEST`。

#21 最终 `provider-boundary.ts` 未改写。手动维护只改变 host operation ID，并记录原 ID 关系；沿用同一 capability、budget ID/限额/deadline 和 onDispatch，不能获得新额度。所有实际 fetch 仍经过原边界，包括完整取得的超限原始字节。

`queryUsage.requestAllocations` 展示实际 intent/response 的用途、请求身份、原始用量、版本化估算及 unknown；最新 committed `pi.usage` 仍只计一次。含手动维护的累计 session 用量不标成原编码任务费用，不将两个来源相加或相减伪造归因。noop 不使已有 known 变 unknown。

## 验证与证据

外部不可变日志、独立安装、原始 SQLite/blob、实际请求 payload、源码/编译/依赖身份位于 `/Users/nineofour/pi-durio-v1-run/evidence/issue-19/`。冻结身份与检查结果见本目录 `acceptance.json`。

行为验证使用真实公开 durable runtime 和明确受控 offline provider：

1. 忙时 compact→重复 compact→steer，先接 steer 后维护，无新编码样本。
2. 真实长源摘要、重复 ID 与短上下文 noop、原文可读、后续独立 task 实际 payload 使用摘要。
3. follow-up→compact→follow-up 的真实源关系；冻结重新接入不跨过失败前序。
4. 只取消当前压缩且后续任务继续；摘要已接入时晚取消保留 applied。
5. 退出后 whole-Harness 冻结；自动生成但 queued summary 同样阻止普通重开。
6. 实际后台/overflow 双 compaction 竞争：较新接入一次，旧摘要 stale；不完整摘要不生成/接入。
7. 实际维护请求与 committed usage 分开归因、累计只计一次；真实 provider-boundary/budget 回归保持通过。
8. TUI 菜单、空闲维护→下一普通输入、历史/失败源禁止隐式操作；这是 adapter 行为检查。

`node scripts/demo-compaction.mjs INSTALL_ROOT NEW_EVIDENCE_ROOT` 用独立安装包的公开 exports 和其 shipped CLI 冷进程执行API 与 CLI 的真实长源维护、重复、冷重开 noop、只读查询不改 SQLite、下一请求的摘要 payload 和旧原文读回。包包含原固定 production dependencies，manifest 绑定每个安装文件、源码 Git tree、编译文件、pack SHA-256 与 lock。

首红日志始终保留：最初去重断言、恢复报告自失效、旧队列 barrier fixture、编译错误及冻结重接来源错误都不覆盖。修正后新增日志另存，不改写过去结果。

付费 provider 未运行；真实模型推理能力未验证。最终完整 macOS Terminal compact 交互由 #31 聚合，本票不将 synthetic TUI 或 CLI 示范称为人工原生验收。用户指定 agent 配置为 `gpt-6-astra` / `xhigh`；可记录请求配置，后端实际服务身份无法由 agent 自证。

### Dispatch 事实补充

`model.fetch-intent` 保存 SDK 交给 host gate 的 payload；`model.dispatch` 仅在实际进入所配置 transport 后保存 `transportEntered=true`。预算或 guard 在入口前拒绝时，`model.dispatch-failed` 保存原始宿主原因和明确未派发事实，即使 Pi 将异常规范化为 `Connection error` 也不丢失原因。`requestAllocations` 对该请求标记 `not-dispatched` / `not-applicable`，不会制造一笔未报告的实际调用；进入 transport 后失败仍 unknown。

旧版无 `transportEntered` 的记录保持原文，以 `unverifiedDispatchIntents` 暴露不确定性。Runtime 的 transport 可能是 eval 中介通道，其入口事实不证明外层 provider 已派发；正式 eval 请求/费用仍由 #21 可信外层记录计算。中止发生在原文保留阶段的检查现在使用真实的 `model.fetch-intent` 边界，既有 stop 语义没有变宽。

## 冻结结果

产品源码 `b556530dcbac6a93255cdbc07e31f9b43b08acdd`（tree `0ff14aa20395ee2091967bb990b424e77409b4d1`）已冻结。核心组合 `4aeb3b6` 的全量为 **133/133 PASS**；后续只读投影改动以 **20/20** 相关检查及 **1/1** 真实预算路径验证。最终 `r4/installed-demo/report.json` 为 **PASS**，包括公开 API 与冷进程 CLI 的实际摘要。未因只新增交付文档重复全量检查。

`r4/manifest.json` 绑定 251 个源码文件、138 个编译文件及 12802 个安装文件；编译产物、package 和 lock 与独立安装逐字节一致。最终 pack SHA-256 为 `84bc499e1e32452e041455f28e0334d1d59582ad3201ec90cfb1ce6da1695524`。旧 `r2` 安装示范保留配置拒绝首败，`r3` 是后续只读投影完成前的包，不作为最终安装验收。

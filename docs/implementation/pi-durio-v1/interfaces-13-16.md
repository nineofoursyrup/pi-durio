# #13 / #16 并行修改归属

这是实施接缝记录，不修改 PI-DURIO-V1-SPEC-r1 的范围。

共同基线为 #11 验收并集成后的 codex/pi-durio-v1。两票均保留公开 `runReadTask(options)`、`readRun(dataRoot, runId, options)`、`readObject` 与现有 record kind/identity 的兼容性；TUI 不获得原始 Harness。任何必要不兼容接口变动先告知协调者，勿各自猜测。

- #13 拥有 runtime、ExecutionEnv、workspace ownership、完整工具原文与 coding 行为测试；可以新增 `runCodingTask` 或等效能力参数，但不让 `runReadTask` 获得隐含写能力。保持 signal/cancellation/onObservation、结果与只读查询现有消费者可用。package/lock 默认不改，确需新依赖先与协调者说明。
- #16 拥有 `src/tui/` 或同等新 UI 文件、TUI 测试、真实 macOS Terminal 验证，以及 package/lock 中精确 pi-tui 依赖、bundleDependencies/分发文件的对应补充。只接 #11 的只读能力，不提早实现 #17 忙时队列或绕过 #14/#15 生命周期/恢复。
- 两票可在 `src/cli.ts` 各自限定区域接线：#13 只扩展 run 的显式 coding 能力与帮助；#16 只添加 `tui` 命令分派/帮助。选择最少改动，merger 串行合并这些确定语义，不重新组织 CLI 架构。若合并影响行为，只补相关接线检查。
- #16 使用 onObservation 作为更新提示，按稳定 cursor 从 readRun 取得已持久事实/原文；如需要新增只读查询字段先明确给协调者/另一票。UI 的草稿、展示及焦点状态不改执行事实，所有退出/中止交给共用 runtime。
- 真实 Terminal 验证必须在 macOS Terminal 运行实际产品并保留环境与观察。合成 PTY/浏览器测试不能替代 IME、复制、键码、窗口和退出清理；无法取得某项证据就报告具体缺口，不能自行把票记完成。付费 provider 始终未授权，可用 offline transport 测终端接线。

2026-10-09 补充：#16 独占新增宿主共用 `src/query.ts`，提供 records 元数据/BlobRef 的分页与原文片段读取；流式 hash/长度验证中同时取得目标片段，仅在身份核对后返回。UI 不直接散布 SQLite 读逻辑。#13 保持 records schema、BlobRef、openHostReadonly 接缝兼容，有必要变更先协调。现有 readRun 默认行为保留。

实际环境缺口：#16 调用 cua.getApp("Terminal") 被工具安全规则拒绝：Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons. 禁止换 AppleScript/其他工具绕过。#16 继续独立实现并准备绑定候选的人工 Terminal 验证脚本；真实 Terminal 证据到达前不记 integrated-accepted、不解除后继依赖。协调者待具体候选/脚本就绪后向用户请求实际操作。

2026-10-09 续：#13 在原 tool.result 保存成功后追加有界派生 tool.summary，提供 attemptId/tool/isError（未知 null）和必要上游 diagnostics/truncation 与原文关联；最终字段由 #13 直接交接 #16。原 tool.result 保持完整。summary 缺失/失败使展示 unknown/degraded，不重跑工具、不改变权威结果。#16 不通过截断正文猜测成功或原文完整性，不为此增加 JSON 流解析器。

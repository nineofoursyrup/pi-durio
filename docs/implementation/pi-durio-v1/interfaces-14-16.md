# #14 / #16 并行修改归属

这是实施接缝记录，沿用 PI-DURIO-V1-SPEC-r1，不修改范围。

- #14 拥有共用 runtime 的停止/退出生命周期、必要的 ExecutionEnv 清理及对应 headless/CLI 行为与测试；不能重写上游调度/恢复状态机。#15 后续负责恢复核对。
- #16 拥有 src/tui、src/query.ts、TUI/查询测试、package/lock 中精确 pi-tui 与分发配置、Terminal 验收脚本和自身文档。其入口仍只接 runReadTask，不提前接入 #17 可写任务/恢复交互。
- 保留 runReadTask、runCodingTask、ReadTaskOptions 的 signal/cancellation/onObservation、RunResult、readRun/readObject 和 host records schema/BlobRef 兼容。#16 当前以 getter 提供 cancellation，在发出 signal 前选择 stop 或 exit；生命周期应按已实际收到的意图处理，不能让后续变化改写原中止意图。有必要变更先协调并保留消费者行为。
- #14 的 CLI 变动限生命周期入口/说明，#16 限 tui 分派/说明。可逆的同文件小冲突由串行 merger 按确定语义合并，并补受影响接线检查。其余 package/lock、query、TUI 文件不交叉编辑。
- 可复用仍适用的确定性证据。#16 真实 Terminal 输入、复制、缩放和退出观察仍为人工门槛；Computer Use 对 Terminal 的安全拒绝不得用其他工具绕过。早期机器/合成检查与人工观察均绑定实际候选，不将部分完成解除依赖。

2026-10-09 追加：#14 可选增加宿主 cleanupTimeoutMs（默认10秒，超时仅unknown而非终止证明）、可选 lifecycle 事实与 waitForRun(promise, signal) 取消调用者等待辅助入口。不得因超时关闭仍在使用的 evidence/storage、丢弃迟到原文或提前释放 owner；取消等待不能取消任务/新调度/改执行事实。首个 signal 的 stop/exit 固定。最终字段由 #14 向 #16 同步；#16 人工候选先绑定已验收 #13，不混入在制 #14。

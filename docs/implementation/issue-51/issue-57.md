# #57 状态行上下文用量：实现说明

状态行格式 `ctx ≈18.2k / 1M`，位于运行状态之后、`usage` 之前。

## 口径

- **分子**：runtime 订阅 `harness.subscribeCommits`，每次提交 entry（回复、输入、工具结果、压缩、系统 entry）后，在监听器之外读取公开接口 `Conversation.context()` 的 `ContextView.messages`，用 pi-ai 公开函数 `estimateContextTokens`（`@earendil-works/pi-ai/utils/estimate`）计算。数值只经 `onContextUsage` 回调显示，不写事实记录，不进入 `RunResult`；读取失败不影响运行结果。
- **分母**：执行所用 `Models` 实例的 `deepseek-flash` 的 `contextWindow`（1,000,000），与 durable 压缩判定同源。只读查看时取该 run 的 `execution.config.model.contextWindow`。
- **“≈”**：估算部分不为零（`trailingTokens>0`）、尚无 usage（`lastUsageIndex===null`）或计入了下面的计划前缀时加“≈”。
- **未走退路**：pi-durable 1.1.0 的公开接口能取到当前送模上下文。

## 受理前与只读查看

- **受理前**（协调人决定）：显示固定前缀估算，即 durable 首次请求前写入的 `pi.system` entry 的估算（instructions section 加工具声明，计入当前生效的 improve 默认配置），带“≈”。由 `estimateTaskPrefix` 计算。
- **会话尚未写入 `pi.system` entry 时**：durable 判定会把计划写入的系统 entry 算进去，显示同样加上固定前缀估算，避免受理后数值先降到只剩用户输入。
- **没有活的 runtime**（`--run`、`/recover` 查看旧 run）：显示该 run 最近一次上报 usage 的 token 总数，带“≈”（其后的内容不做估算）；若没有上报，则显示固定前缀估算。

## 与 durable 判定的已知差异

durable 的 `estimateContext` 没有从公开入口导出，按 ADR 0001 不复制。差异如下：

1. 选取基准回复时，durable 不跳过带 usage 的 error/aborted 回复，pi-ai 会跳过。
2. 压缩后选取基准时，durable 以 head marker 为界，pi-ai 以时间戳前缀为界；通常结果一致。
3. 计划写入的系统 entry：durable 计入本次请求实际计划的 entry。显示只在上下文里还没有系统消息时，加上固定前缀估算。

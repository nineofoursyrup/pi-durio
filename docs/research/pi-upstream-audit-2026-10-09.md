# pi-durio 上游快速事实核对

核对日期：2026-10-09（Asia/Shanghai）。用途：Wayfinder 建图前的事实输入，不代表架构决策或实现验收。

先读取本地规格 `pi-durable-coding-agent-spec.html` 第 22 章，再核对第 5、6、8 章相关主张。已遵守 `docs/agents/domain.md`；本次未发现既有 `GLOSSARY.md` 或 ADR。仅读取官方源码和 GitHub 元数据，未安装依赖、运行测试、调用模型、写入 GitHub 或提交代码。

## 结论

本次 GitHub API `repos/earendil-works/pi/commits/main` 返回 `6fb2e7815167e6b19006fc526d1a5d0f5f998787`，提交时间为 `2026-10-08T15:26:34Z`，与本地规格研究快照相同。因此在本次观察时点，main 相对规格快照没有漂移。后续实现仍应固定版本；这不是 npm 发布状态验证。[固定提交](https://github.com/earendil-works/pi/commit/6fb2e7815167e6b19006fc526d1a5d0f5f998787)

上游已有可复用的 agent loop、持久化任务、工具、恢复、会话 usage 和 UI 投影。pi-durio 的主要增量可以集中在薄宿主、运行记录与查询、eval 入口以及用户明确触发和选择的 `improve` 流程。最后一句是规划推论，不是已测得的工作量或体积结论。

## 可直接采用的事实

| 核对项 | 观察到的上游事实 | 对规划的含义 |
| --- | --- | --- |
| 名称和运行时 | `@earendil-works/pi-durable` 为 ESM；快照版本 `1.1.0`，Node `>=22.19.0`；公开导出 root、env、tools、memory/JSONL/SQLite storage、testing。直接依赖 chord、pi-ai、diff、typebox。 | 使用公开入口即可构造基础宿主；不能把薄宿主视作整个产品零依赖。[durable package.json](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/durable/package.json) |
| 间接依赖 | `@earendil-works/chord` 声明运行依赖 esbuild；pi-ai 有 provider 子路径，同时声明 Anthropic、AWS Bedrock、Google GenAI、OpenAI 等 SDK 依赖。 | 命名 provider 导入与普通安装依赖体积是不同指标。[chord package.json](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/chord/package.json)、[ai package.json](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/ai/package.json) |
| TUI 包 | `@earendil-works/pi-tui` 也是 `1.1.0`、Node `>=22.19.0`；发布文件包含多个平台的原生剪贴板 prebuild/source。 | 安装目录、单平台分发包和 bundle 必须分别测量，当前没有体积数字。[tui package.json](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/tui/package.json) |
| 核心能力 | `Harness.open()` 与 `root().submit()` 已驱动 generation/tool 任务；`resume()` 恢复 pending 工作；有 compaction、`viewState()`、`watchEvents()`、`pi.usage`。README 标记 API 为 Experimental。 | 无需重写基础 loop 或恢复状态机；升级需核对兼容性。[durable README](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/durable/README.md) |
| 官方 demo | 一个进程管理 ModelRuntime、Harness、SQLite、TUI；以 monorepo source resolver 启动，复用完整 Pi 的认证、设置和交互组件，登录依赖 Pi 本体。 | 它是架构和行为参考；抽离仍需要决定自有初始化和认证路径。[demo README](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/src/experimental/durable/README.md) |
| demo 发布边界 | runtime 引入 `../../core/model-runtime.ts`、`../../core/settings-manager.ts`；完整 coding-agent 的 `files` 排除 `dist/experimental`，没有 durable demo 稳定公开导出。 | 不能假设安装 coding-agent npm 包后直接 import demo 即可运行。[runtime.ts](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/src/experimental/durable/runtime.ts)、[coding-agent package.json](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/package.json) |

## 恢复、记录与评估边界

- 工具先提交 intent，再执行。未声明 replay 时为 `unsafe`；恢复只在持久化策略和当前工具都为 `safe` 时重跑。恢复分支直接进入 `run()`，不重新调用 `beforeTool`。因此 `improve` 分析阶段的只读能力和选中后的执行授权不能只靠 prompt 或 `beforeTool`。[tool.ts](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/durable/src/harness/tool.ts)
- Node SQLite 使用内置 `node:sqlite`、WAL 和 `synchronous=NORMAL`。durable 声明 storage 单进程所有权且不提供跨进程锁；demo 通过 `proper-lockfile` 补充会话锁。不能承诺断电零丢失，或据此推断工具外部副作用 exactly-once。[SQLite adapter](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/durable/src/storage/sqlite/node.ts)、[durable README](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/durable/README.md)、[sessions.ts](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/src/experimental/durable/sessions.ts)
- `pi.usage` 按 conversation 保存模型和工具报告的用量，在记录响应的同一 commit 汇总；包含 compaction summarization attempts。它是已记录用量事实，不能证明 provider 未返回或崩溃前未提交的费用为零。watch/event 慢消费者可改收 snapshot，因此 UI 流不适合作无损审计账本。[usage.ts](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/durable/src/harness/usage.ts)、[durable README](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/durable/README.md)
- `@earendil-works/pi-telemetry` 提供中立 contract、NOOP、内存参考和 conformance，未提供 exporter/backend；内存参考为无界、进程内存储。pi-ai 传递 telemetry context，业务 span 和落盘/导出仍需宿主设计。`Models.completeSimple()` 调用 `streamSimple(...).result()`，同时包装两处会双计。[telemetry README](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/telemetry/README.md)、[models.ts](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/ai/src/models.ts#L901-L915)
- `@earendil-works/pi-evals` 为 private workspace，开发依赖包含 coding-agent、vitest-evals、autoevals。不能视作公开的 durable eval SDK；可借鉴，但 pi-durio 的最小 eval 入口及长期评估合同仍需确定。[evals package.json](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/evals/package.json)

## 最多三个实质未决问题

1. **轻量优先优化哪个指标，如何计量？** 自有 LOC、冷启动、RSS、安装体积、分发体积和依赖数量会得出不同取舍。建议先确定少量主指标并测基线，再讨论 provider 裁剪或 bundle；当前没有性能承诺。
2. **首版薄宿主的复用边界是什么？** 建议以 durable/pi-ai/pi-tui 公开接口为边界，参考 demo 分层；provider、认证方式、demo 私有组件是否有必要移植应一起判定，避免以少量宿主代码掩盖完整 coding-agent 依赖。
3. **首版运行记录和 `improve` 的最小合同是什么？** 需明确 run/attempt、已知 usage、trace、eval trial、证据和候选的关联与保留；还要决定如何强制分析只读、选择范围、版本生效与 pending task 兼容。建议在此处固定必要行为，再选择最小存储/查询实现。

## 未核实

没有核对 npm 当前发布/可安装性、lockfile 解析结果、实际 bundle/安装体积、冷启动/RSS、provider 实际认证或模型质量；没有运行上游测试。本文为快速源码核对，不替代实现阶段的针对性验证。

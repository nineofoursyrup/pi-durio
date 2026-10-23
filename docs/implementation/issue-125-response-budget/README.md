# #125 输出上限驱动的 provider 响应预算

实现范围：[Issue #125](https://github.com/nineofoursyrup/pi-durio/issues/125)，基线 `0630c5fada520c1deefedcb03cb410168c39428b`。2026-10-24（Asia/Shanghai），全部验证使用离线合成响应。

## 行为

共享计算位于 `src/provider-response-budget.ts`：`65,536 + maxOutputTokens × 512`，合法输出范围为 1–65,536 tokens，最大 33,619,968 字节。超范围、非整数或非有限值拒绝，不截成硬上限。适用假设是每个输出 token 最多一个 content/tool_calls SSE 事件，另有 base 容纳终止事件；依据和重新测量条件写在函数注释及回归中。

improve、带 providerBoundary 的请求、继承边界的 compaction、eval mediator 和 guest 使用同一计算。每次请求取宿主上限与上游实际 `maxTokens` 的较小值，同步用于 SDK 与字节预算；不会把 compaction 原有较小上限提高。没有固定宿主上限时，带边界的 compaction 使用上游实际 `maxTokens`。没有输出上限的调用仍使用已有字节策略。单帧保护、取消、deadline、越界块先保存、未知 usage 预留和 settle-once 没有放宽；`IMPROVE_REPORT_LIMIT` 仍为 131,072 正文字节。

## eval 容量

隔离脚本未改动。其现有计数方向为：

| 限制 | 实际计数对象 | 保持的上限 |
| --- | --- | ---: |
| inputBytes | guest 请求中的 input 字符串 | 262,144 |
| responseBytes | mediator 返回的 JSON 字符串 | 1,048,576 |
| lineBytes | guest stdout 待解析的请求行 | 1,048,576 |
| totalBytes | guest stdout 累计；stderr 另有独立限制 | 8,388,608 |

宿主的 `model.response` 写入 guest stdin，其外层序列化大小单独测量，不误计为 guest stdout。

内容、tool_calls 以及引号、反斜杠、换行、tab 的合成样本，经两层 JSON 序列化的膨胀约为 1.147 倍、1.434 倍。实现向上取整为 mediator `ceil(raw × 1.2) + 4096`；外层响应的内存估算为 `ceil(raw × 1.5) + 8192`。这些是假设已记录的响应形状余量，不是任意 provider 元数据的数学保证。系数从实测约 1.146 向上取整到 1.2，是为已测事件形状内的字段长度和转义比例波动预留余量，避免把有限样本的最大值当成保证上界。

由 mediator 容量反推，新计划最多 **1572 output tokens**，默认 **1024**。1572 对应 870,400 原始字节和 1,048,576 估算 mediator 字节；1573 在启动前被拒绝。

请求行预留 `2 × inputBytes + 128 = 524,416` 字节，另留 65,536 字节 stdout 诊断余量。总量校验同样参与启动判断：15 次请求可容纳，16 次不能。当前产品和 mediator 对每 trial 实际最多放行 8 次，因此合法产品计划的总量不成为更低的 token 阈值；batch 的 maxRequests 跨多个独立 VM，不能全计到某一个 trial。comparison 还受其更小的 trialBudget 限制。

guest 保留实际较小的输出上限，宿主校验请求声明与 payload 相同且不超过 plan；单次响应按实际值限制，启动容量和未知 token 预留仍按完整计划保守计算。

improve 生成 fresh check 的声明校验也接入同一容量计算：使用声明自身的 `budget.maxRequests` 和 `comparison.trialBudget.maxRequests`，经 `evalTrialRequests` / `maxEvalOutputTokens` 得到上限。1572 通过，1573 和旧默认值 2048 在声明阶段以 `IMPROVE_FRESH_DECLARATION_INVALID` 被拒绝，早于宿主绑定和 `prepareEval`。

旧固定计划仍可读取和显示；准备新计划、启动固定计划、直接构造 mediator 均验证新容量，不能通过历史读取入口启动超容量计划。

## 前一轮实现验证（声明补修前）

前一轮构建通过；100 个测试文件共 **744 项**检查已全部覆盖通过，按共享锁串行分批执行，最后的行为修正后重跑受影响项。没有真实模型请求，未提交、推送、修改票据或固定新的付费计划。

| 检查批次 | 通过数 | 结果来源 |
| --- | ---: | --- |
| 其余 95 个测试文件 | 687 | `remaining.log` |
| provider-boundary（实现与输入未变，复用） | 15 | `focused-1.log` 中该文件全部通过 |
| compaction 未变行为（复用） | 15 | `focused-2.log` 中该文件全部通过；另 1 项见下一行 |
| 手动 compaction 保留更小上限 | 1 | `compaction-final.log` |
| 最终 eval / runtime-provider / improve | 26 | `affected-final.log` |

日志与首败记录位于本 worktree 的 `.scratch/issue-125/`；该轮摘要及构建、文件校验值保留在 [validation.json](validation.json)；它记录补修前的源码状态，本轮补修结果见下文。`npm run build` 已包括 TypeScript 编译与源码/输出对应清单，无需另跑重复的 typecheck。`git diff --check` 通过。

回归包含 #124 原样合成形状：19,990 字节 JSON、5,000 个事件、1,444,783 原始字节。不同网络分块取得相同完整 JSON；有 usage/DONE 与缺失 usage 分别覆盖。improve 和实际 compaction 路径验证超过旧 1 MiB 的完整响应；eval 验证 mediator 序列化往返及 guest 实际 runtime 适配器。另覆盖超限取消、越界原文保留、error/unknown 单次结算、单帧保护、非法配置无 dispatch、容量边界和旧计划只读。

初轮定向检查保留了失败记录：旧强制 compaction 夹具将 reserveTokens 设置到 999999，SDK 因而申请 384000 output tokens，新硬上界下需显式固定合法输出上限；长流新增断言最初只读取了前 200 条事实，现通过分页取得终止记录；未知 usage 的顶层结果为 `TASK_UNANSWERED`，拒绝原因在 dispatch 事实和预算中，断言已对准这两个接口。未改写首败记录。

独立评审：Standards 0 findings；Spec 首轮发现错误计入宿主响应的 P2，修复后 0 findings。

## 可复现内存与转义测量

构建后，独占共享测试锁、没有其他测试负载时运行：

```sh
node scripts/measure-response-budget.mjs 1 NEW_EVIDENCE_DIRECTORY
node scripts/measure-response-budget.mjs 8 ANOTHER_NEW_EVIDENCE_DIRECTORY
```

脚本使用实际 mediator、两层 JSON 往返和 guest provider 边界，保留宿主原文与 usage 事实；填充 SSE comment 使每份原始响应恰好达到新字节预算，记录 RSS、heap、external/arrayBuffer 及进程峰值 RSS。它是单 Node 进程的离线传输测量，不是整个 VM、完整 runtime 或真实模型的峰值承诺；guest runtime 路径由上述集成回归另行覆盖。改变 provider 或事件形状需重新测量。

实测环境：Node v26.8.2，darwin/arm64。每请求上限 1572 tokens；每份原始响应 870,400 字节，mediator 包装后 928,630 字节，外层行 1,040,309 字节。1 次和 8 次往返全部取得完整响应与 usage。

| 连续请求数 | 初始 RSS MiB | 进程峰值 RSS MiB | 阶段采样最大 heapUsed MiB | 阶段采样最大 external MiB |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 44.59 | 87.77 | 25.55 | 8.55 |
| 8 | 44.66 | 128.88 | 45.85 | 14.41 |

数据：[单请求](measurement-1.json)、[8 请求](measurement-8.json)。真实序列化样本的最大膨胀分别为 1.14643、1.43377 倍。RSS 是进程峰值；heap/external 是阶段采样最大值，不冒充全程峰值。未强制 GC、未扣减初始 RSS，不外推为稳定性结论。


## fresh 声明容量补修（2026-10-24）

本轮只补声明阶段的容量检查、删除 eval 结构校验里重复的 `>16384` 条件，以及相关回归和本记录。`Number.isSafeInteger` 与正数检查保留；现有 6000-token 旧计划只读回归保留，并新增 16385-token 旧计划只读成功、启动前仍拒绝的回归。`loadEvalPlan` 仍在内部使用 `{forExecution:false}`，没有更改其接口。`src/improve.ts`（包括 S3 冻结的 `IMPROVE_INSTRUCTIONS`）保持逐字节不变。错误码断言使用字面量，遵循 S4。

可选项已完成：在既有 provider 预算测试中断言 `RESPONSE_HARD_CAP_BYTES === providerResponseBytes(65536)`；保留原有 33,619,968 字节字面量断言。

补修验证：`npm run build` 通过；以下 4 个受影响文件共 **61/61 项**通过，0 失败、0 跳过。使用同一机器共享锁、`--test-concurrency=1` 串行测试及禁止真实 fetch 的预加载模块；未重跑全量套件。

| 测试文件 | 通过数 |
| --- | ---: |
| `test/improve-selection.test.ts` | 23 |
| `test/improve-contracts.test.ts` | 8 |
| `test/eval.test.ts` | 15 |
| `test/provider-boundary.test.ts` | 15 |

```sh
node --test --test-concurrency=1 dist/test/improve-selection.test.js dist/test/improve-contracts.test.js dist/test/eval.test.js dist/test/provider-boundary.test.js
```

日志：[build](../../../.scratch/issue-125/spec-gap-build.log)、[61 项定向测试](../../../.scratch/issue-125/spec-gap-tests.log)。`git diff --check` 通过；本轮仅修改上述范围内的 6 个文件，既有其他改动保留，未提交、推送或发起真实模型请求。

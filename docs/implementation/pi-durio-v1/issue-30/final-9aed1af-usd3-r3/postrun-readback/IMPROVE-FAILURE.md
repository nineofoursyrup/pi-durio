# LIVE-USD3-R3-01：终止 SSE 的已知用量在正常取消 reader 时丢失

结论：这是实际冻结产品的 provider boundary 结算缺陷。已有 raw response、host journal、SDK 成功响应与安装源码共同给出因果链；没有为了诊断重放请求或执行产品。

## 精确证据链

同一 host 请求 `5ae550cf-a637-458a-80fa-d518e4ff9aae`，model attempt `f4754a24-9dc0-401f-9c42-3c3ad261a7f6`，improve run `f05d3379-5950-4bfa-aebd-72dd671c4fc3`：

| 序号 | 真实时间（UTC） | 观察 |
| --- | --- | --- |
| 67 / 69 | 见 `improve-timeline.json` | 一次 provider.dispatch / HTTP 200 |
| 88 | 06:41:35.550 | 最后 raw chunk 包含 usage 923 + 29 = 952、tool_calls 与 DONE |
| 89 | 06:41:35.560 | model.provider-event 已保存同一 usage |
| 90 | 06:41:35.570 | budget.settle 写入 tokens null、cancelled、reason undefined |
| 91 | 06:41:35.585 | SDK model.response complete / toolUse / usage 952 |
| 93–95 | 06:41:35.611–.636 | evidence_summary dispatch、summary 和 result 正常完成 |
| 97 | 06:41:35.664 | 下一次 generation.request |
| 100–101 | 06:41:35.699–.710 | fetch intent 后发生 BUDGET_UNKNOWN_USAGE；dispatched=false、attemptDispatched=false |
| 102–103 | 见时间线 | SDK 表面 Connection error；submission model_error / unanswered |
| 110–111 | 见时间线 | improve incomplete / BUDGET_UNKNOWN_USAGE；run failed / TASK_UNANSWERED |

最后 raw chunk SHA256 `a6c66b38e6e0a7fd497a203795724446440c8cababf717e5702c64fc0bc3bbf8`，469 bytes。7 块拼接响应 SHA256 `32104d7dc8f7ef436b2f65544a3ec748e1c4a282f6c7a318dc970a1889421555`，3830 bytes；新派生副本为 `improve-response-derived.sse`。原 chunk 引用、seq、时间与 journal blob 哈希在 `improve-timeline.json`，原 SQLite 与所有 blob 均不改写。

## 与精确安装版本匹配的代码机制

- `src/provider-boundary.ts:54` 从 SSE data 行读取用量；`[DONE]` 无 JSON 可解析，因此被忽略。
- `src/provider-boundary.ts:56` 仅在底层 `reader.read()` 得到 EOF 时执行已知用量结算。
- `src/provider-boundary.ts:61` 先解析取得的 chunk，再向 SDK enqueue；因此真实 seq 88 的用量已取得。
- `src/provider-boundary.ts:63` 的 `cancel(reason)` 无条件结算 `null / cancelled`，没有利用已取得的终止响应状态与用量。
- 安装的 `openai/core/streaming.mjs:97` 在收到 `[DONE]` 后 break；嵌套 iterator 关闭。
- 同文件 `createAbortableSSESource` 在 344–350 行把 source.return 接到 `reader.cancel()`；475–538 行的 SSE 遍历与 finally cleanup 完成这一路径。这是 SDK 按协议结束流的行为，并不需要用户 abort。
- `src/improve.ts:76` 设置 `unknownUpperBound:null`；`src/provider-boundary.ts:30` 遇到未知用量拒绝下一请求，恰好对应 seq 101 的本地拒绝。

源码、compiled boundary 与 SDK 文件的 frozen 绑定和当前 hash 见 `report.json.codeBindings`。当前观察不能把通用 `cancel` 当作始终成功；真实取消、缺失终止标记、非法/缺失用量、消费/传输错误仍需保持保守结算。

## 最小修复建议及必须保留的边界

只调整 provider boundary 对协议终止与 reader 关闭的判定：已取得有效终止 SSE 响应和有效用量时，SDK 正常结束 reader 不应抹掉该已知用量；区分真正的 abort、截断或出错。不得简单将全部 cancel 改成 returned，也不得因看到任意早期 usage 就证明响应完成。

后续实现应验证 DONE 与 usage 同块、跨块及换行边界、终止后 SDK consumer cancel、正常 EOF、真正提前 cancel/abort、缺失/非法 usage、错误/响应限额、单次结算与 unknown 继续阻断。它们是后续实现验证建议，本报告未执行测试。

不得改变正式单任务 8 次请求限制、不得用 raw 952 重写旧 UNKNOWN、不得放松授权、成本或工具边界。旧首失败与原调用输出保持不变。SDK 表面 Connection error 可在后续产品文案中改进，但它不是本次使用量误判的根因，也不应扩大当前最小修复范围。

## 验收与候选状态

此失败记为 **LIVE-USD3-R3-01**，影响 #23 的真实 improve，由 #30 发现。历史 offline PASS 保持其当时范围；新产品修复及受影响复核之前，当前真实路径没有通过。原 report `v1-live-r2-improve` revision `cc9cbac2720484f05b11666fc06621f9be03fbc40a90ed1d48924397493f19b6` 为 incomplete，候选与选择均为 0。未生成可选择包，未运行候选 check 或 writeback。

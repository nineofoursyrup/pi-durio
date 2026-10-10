# #30 首次真实批次：只读首失败诊断

结论：原 r2 批次仍是 **STOPPED**。`local-fix` 真实 PASS；`multi-file` 在正式 runtime 的 8 次请求内没有完成一致的改动，第 9 次 generation 被请求上限拒绝；后续两例及 `improve` 均未执行。当前证据不支持产品工具接线缺陷或提高固定 8 次限制。

本诊断绑定产品 `9aed1af6ee3b156bb7354961496217aa5e64843e` 与 r2 manifest `51ff05f19a55cd14653f1f00dc7a07d4bc5f9931b7107091ad5207ce0e269486`。批次于 `2026-10-10T05:53:39.641Z` 启动，于 `05:54:47.608Z` 记录 `BATCH_TRIAL_NOT_PASS`。原 `paid-start`、结果、清单、所有失败和 journal 均保留。原一次启动授权已消耗。

## 原始结果与失败链

| 案例 | 物理 host 请求 / tokens | outcome | 原始 grade |
|---|---:|---|---|
| local-fix | 7 / 13,370 | completed / valid | PASS：scope、task 均通过 |
| multi-file | 8 / 14,129 | error / valid；runtime `TASK_UNANSWERED` | unknown：scope 通过，grader 启动前取消 |
| regression | 0 / 0 | not-run / cancelled | 无 |
| no-change | 0 / 0 | not-run / cancelled | 无 |

`multi-file` 的第 4 个响应把初始 `greeting()` 当作需要保留的用户改动，另加 `namedGreeting()`、`adaMessage`。第 6 个响应尝试在只读 `/tmp` 写检查，失败文本被保留；第 7 个响应检查了其自行引入的接口。第 8 个响应重新理解原需求后，只把 `greeting.ts` 改成 `greeting(name)`，没有同步改 `main.ts`。这些日志中的命令仅作证据读取，本诊断没有执行它们。

最终保留的 `greeting.ts` 仅导出 `greeting(name)`；`main.ts` 仍导入 `namedGreeting`，并保留 `message = greeting()`。最后一次 `file.write-result`（guest seq 1066）成功取得的 SHA 与最终文件相同，未发现写入丢失证据。

| 文件 | SHA256 |
|---|---|
| greeting.ts | `087823927c237d65b49ca53dda65ad0bd2eb2b2a24bb3922484cb7734a35c953` |
| main.ts | `44e74018b054b9fd0820a3602418018e6574892ef2578207282f0c5f279ebb28` |

guest 有 9 条 `generation.request`，只有 8 条 `model.intent` / dispatch / response，全部为 generation。第 9 条请求（seq 1069）之后，`submission.settled`（seq 1070）为 `unanswered / faulted`，明确记录 `REQUEST_LIMIT: this task reached its provider attempt limit`。没有第 9 次真实 provider 调用；没有自动重试或 compaction 消耗这 8 次。

正式 `runtime.ts:481,508` 固定编码请求上限为 8，检查在建立新的 `attemptId/model.intent` 前执行；`:714` 将未完成 submission 映射成 `TASK_UNANSWERED`。`eval/guest.ts:22` 原样传入案例 prompt。`eval/runner.ts:112–116` 保存 outcome 后触发外部 harness 的首非 completed 停止门；随后 scope 检查通过，但 grader 因取消没有启动，所以原始 grade 必须保留 `unknown`。上述源码逐字节匹配实际安装候选的 `source-build.json`，见 [source-verification.json](source-verification.json)。

## 独立只读检查及其边界

[artifact-link-check.json](artifact-link-check.json) 使用已导出的准确文件做 TypeScript 去类型和 ESM **解析/链接**，没有执行模块、产品 grader、模型命令或 restricted VM。`local-fix` 文件可链接；`multi-file` 确认 `SyntaxError: The requested module './greeting.ts' does not provide an export named 'namedGreeting'`。这是独立诊断结果，不能改写为原 grader 的 FAIL，也不能升级成一次新的真实评测。

[observed-facts.json](observed-facts.json) 为只读提取结果；3167 个读取过的原文件/object 在检查后重新核对，0 个字节变化，见 [preservation-check.json](preservation-check.json)。诊断没有读取 `api.env`，没有 provider 请求、restricted VM 启动、产品运行/build 或原结果写入。完整读取身份索引保留在外部同名目录的 `read-identities.json`，hash 记录在 preservation check。

## 用量和模型身份

15 次物理 host 请求均有配对 reserve / HTTP / settlement / guest link，全部 HTTP 200；逐次 raw SSE 的 usage 与 settlement 相符，共 **27,499 tokens**，unknown settlement 为 0，结束时 reservation 为 0。按原冻结最高价 `USD 1.20/M` 计的保守 host 估算为 **USD 0.0329988**。SDK catalog 对同一用量的估算为 **USD 0.004293852**；两者不能相加，guest 镜像请求也不能再计一次。账户实付未观察。

15 份 raw 返回均标示 `model=deepseek-flash`、`system_fingerprint=aeb56401ca74e127821c4f9126dcb669`。它们是本次返回身份观察，不证明不可变模型版本或权重。managed cleanup 已记录 confirmed；外部进程和远端终止状态仍保留 unknown。

后续仅有待审阅的 [方案](NEXT-BATCH-PLAN.md) / [plan.json](plan.json)。本诊断不授权新付费启动，不修改产品固定 8 次限制，也不宣称 #30 完成。

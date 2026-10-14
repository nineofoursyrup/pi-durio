# improve-only repair r2 真实启动读回

**本次传输与结算核对通过，正式 improve 报告仍 incomplete / 0 candidates。** 一次授权已消费；没有补跑、选择或执行候选。原结果、raw 响应、fixture、预算和旧 UNKNOWN 均保持原样。

## 本次身份和结果

- manifest：`c1a3904f047ff3c19b16ba7c7e66dc57316f2ff9ad08a7080791ee5babe5fb2a`；产品 candidate `f26ae8f4b8039608a1fa796e1c69da4d8173d112`，producer `78130b154fe8dad9097c05afb24ff9d1d24d8bce`。
- 人类授权记录时间 `2026-10-10T09:43:21.324Z`；直接回复来源绑定 `call_424879d068884d7f83524572607e2de6`。授权只覆盖这一次 analysis。
- paid-start `2026-10-10T09:44:47.198Z`；batch ended `2026-10-10T09:45:37.085Z`；调用进程 exit 1。
- run `7e5947a8-e3aa-48d1-a513-db3736c4f5ab`；report `v1-live-r3-improve`；正式 revision `aaaa4af52f3e34ecb287d99b27d861da3baf3d5c21b1a48987b9cd12daf0fd90`。
- runtime `completed`、`cleanup=confirmed`、`storage=closed`；batch `STOPPED_NO_EXECUTABLE_CHAIN`。remote termination 按原记录仍为 `unknown`。
- 正式 report `incomplete`，`candidates=[]`、`selected=[]`；live、reopened 与持久化 `improve.report` 完全一致。

## 七条物理请求

| 次序 | dispatch seq | settle seq | known tokens | finish_reason |
| --- | ---: | ---: | ---: | --- |
| 1 | 67 | 95 | 956 | tool_calls |
| 2 | 107 | 265 | 2696 | tool_calls |
| 3 | 292 | 533 | 3704 | tool_calls |
| 4 | 555 | 812 | 5488 | tool_calls |
| 5 | 834 | 1558 | 8609 | tool_calls |
| 6 | 1570 | 1681 | 9163 | tool_calls |
| 7 | 1693 | 5717 | 13850 | stop |

每条均 HTTP 200；原 raw SSE 恰有一个完整 `[DONE]`，terminal usage 的 `prompt_tokens + completion_tokens = total_tokens` 与对应 host `budget.settle` 一致，settlement 状态均 `returned`，发生于最后 raw chunk 之后。本次共 1,233 个原始网络 chunk，未发现新 unknown、超界或第八次物理 dispatch。前六次请求调用工具，最后一次返回文本并正常 stop。

七条 raw response 的 model 均为 `deepseek-flash`，system fingerprint 均为 `aeb56401ca74e127821c4f9126dcb669`；这些是实际响应元数据，不证明不可变权重或服务端版本。完整原请求 body 与合并 SSE 是只读衍生副本，按原 chunk 顺序和哈希绑定在外部 `raw/` 与 `raw-chunk-index.json`，原件未改动。

本轮仅观察到 13 次只读工具调用：`evidence_summary` 2 次、`source_view` 4 次、`evidence_read` 7 次；没有本轮 tool error、候选操作或 fixture 写入。原 synthetic seed 的 shell 失败属于历史输入，不能算成本轮执行失败或新 shell 调用。

## 预算

| 项目 | 本次新增 | 累计 |
| --- | ---: | ---: |
| host requests | 7 | 41 |
| known tokens | 44,466 | 106,026 |
| UNKNOWN reservation | 0 | 1,056,768 |
| charged upper tokens | 44,466 | 1,162,794 |
| USD 保守估计 | 0.0533592 | 1.3953528 |

累计 `boundExceeded=false`，未观察账户账单。原 r3 UNKNOWN reservation `1,056,768` 完整保留，没有用其 raw 952 替换历史结算。SDK mirror 同样为 44,466 tokens，catalog estimate 为 USD 0.008474952；它与 host 覆盖相同请求，不重复相加。

## 原始文本与正式报告的区别

最终回答前缀是 `I have all acquirable evidence. Returning my structured report.`，随后为 Markdown JSON 围栏。正式失败原因：`SyntaxError: Unexpected token 'I', "I have all"... is not valid JSON`。

原文围栏内有 **2 份提案草稿**：第一份声称修复 clamp，第二份记录 withheld evidence gap。这里只把它们作为 raw 文本建立索引，没有生成正式 candidate ID、改写 report、人工删改拼接候选或赋予用户选择权限。

协调者的独立只读诊断保存在 `diagnostic-only/`：直接严格解析复现原错误；仅为诊断提取围栏后，当前安装包原样 pure candidate validator 仍报 `IMPROVE_CANDIDATE_CONTRACT_INCOMPLETE`。第二份草稿的 steps/checks 为空且把 withheld 的 `e1:24` 当作 acquired 事实引用。第一份草稿另有两条原表达式算术陈述错误：`[-9,-5,-1]` 的原结果为 -9 而非 -5，`[6,0,10]` 为 0 而非 6。诊断只核对原表达式，没有执行候选或 protected check。

因此，去掉围栏不能使报告成立；现有严格格式和候选合同的拒绝行为符合约定，未证实产品解析缺陷。两份草稿的 `activation.writeback/enable` 都为 false，schema 检查也不能证明自然语言推理正确。诊断辅助 collector 首次 `KeyError: sourceId` 已单独保留，属于取证脚本 shape 假设失败，不是产品首败。

## 原件保护和范围

取证以 SQLite `mode=ro&immutable=1` 和普通文件读取完成，不导入产品 API。12,074 个被读原件在前后哈希核对中全部一致：包括本批 4,419 个原文件、旧闭合链 7,264 项及失败冻结 r1 的 368 项；集合存在引用去重，不作简单数量相加。四个 fixture 文件仍匹配 frozen baseline。

`report.json` 是事实汇总；`requests.json`、`timeline.json`、`raw-answer-index.json` 保留对应证据位置。较大的 DB/raw chunks/完整 12,074 项清单留在外部，由 `evidence-index.json` 绑定；仓库只保存本轮必要取证与诊断副本。没有新 provider、VM、Terminal、授权、候选执行、产品修改或 root/status 写入。

后续若准备新的输入 revision，必须保留本轮失败与旧预算，并另行冻结、独立复核和取得直接人类的一次启动授权。本报告不将本轮 incomplete 视为 #30 完成或产品验收。

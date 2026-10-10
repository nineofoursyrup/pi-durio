# R1 一次候选执行方案：当前未授权

这是可审阅的计划，尚未选择、验证或执行候选。`authorized:false`，实际选择/来源/时间与 deadline 均为空；`decision-data`、`validation-work`、实际 selection 和 execution-start 文件不存在。结构化草稿带外层未授权封套和 null deadline，不是可提交的公共 API decision。

## 实际候选与错误假设

报告 `v1-live-r4-improve` / `b8e9b7c7c08d06d5ed955339630fac5e1b8fe59e6e700acd6499863d932aad2a`。
候选 R1 `candidate:197afe0a113c5c58ad0810ca24a4ad98` / `49e9331f282cda12efe5fb89f4b6ef35b8e50a8dc2d8140fa48c5fe3824c91c8`。
原始 baseline `46864e756634ac28260fe43119d15103008ce1a2fbc9b37b548c2b2027ab257f`。

候选摘要开头及 hypotheses[1] 存在错误：在 lower <= upper 下，旧表达式等于 min(lower,value)，区间内的 6 和超上界的 14 在 (0,10) 边界下都返回 0，并非原本通过。原报告、候选、revision 原样保留，独立 static-analysis 只陈述该问题。拟改表达式静态符合既有 README；实际检查尚未运行。

唯一拟写内容是 clamp.ts（111 bytes）：

```ts
export const clamp = (value: number, lower: number, upper: number) => Math.min(upper, Math.max(lower, value));
```

before SHA `b33b7f38ce6fa4d07899ebd5494dd7d800d2b554752b25ed7645d9b0827bd4fc`；after SHA `45e016afe980df19159fc0679a6e44d88838a7a5afc398820309b576884f003c`。精确全文在 `proposed-clamp.txt` 与 draft 的 changes 中一致。其他三文件 README.md、check.mjs、package.json 全部受保护，包含已有用户草稿。

## 人类选择与一次执行

可选择执行此固定计划，或暂缓并保持无产品动作。此计划不包含 validate-only、重新分析、其他候选、自动选择、额外 paid start、默认启用或自动回滚。

独立评审完成后，协调端仅依据新的直接人类回复创建 `actual-selection.json`：选择 `execute-declared-scope`，绑定本目录冻结 manifest 的实际 SHA，保存 author/source/call ID/原话/时间，并记录用户已获知原推理错误。现有仅分析的授权已消耗，不能沿用。模板保持 false/null；不因计划存在而视为选择。

开始必须在实际批准后 24 小时内。启动时才生成一次 startedAt 和 `deadline=startedAt+5min`，写 `execution-start.json` 后即消耗一次入口。没有准备时就开始倒计时的绝对 deadline，没有重试或延长。

协调端未来仅在上述授权有效后运行：

```sh
/opt/homebrew/bin/node /Users/nineofour/pi-durio-v1-run/evidence/issue-30/improve-output-contract-r1/candidate-execution-plan-r1/execute-selected.mjs /Users/nineofour/pi-durio-v1-run/evidence/issue-30/improve-output-contract-r1/candidate-execution-plan-r1/actual-selection.json
```

## 公共接口、原件保留与预算

复用已安装产品 `pi-durio/improve-decisions` 的 `previewImproveDecision` → `submitImproveDecision`；只读重开通过 `readImproveDecision` 与 `pi-durio/improve.readImproveReport`。不调用 Harness.open，不调用分析或 provider 设置接口。安装树和 source-build 在实际入口再次验证。

批准后才把已关闭原 improve-data 的精确 3427 文件复制到独立 `decision-data`，逐文件验证相同字节与独立 inode。原分析目录不改动。绑定 global cutoff 4298；克隆后先确认报告/候选/revision 全部相同且仍无选择。只有 clone 中 seq > 4298 的新增记录才计为候选动作。

克隆包含当前分析的 4 条既有 provider.dispatch，它们已属于累计 45 次请求，不再计费；更早已计费记录仍通过累计账本保留。累计已知 130611 + 旧 UNKNOWN 1056768 = 1187379 tokens，保守 USD 1.4248548，旧 UNKNOWN 不改写。此决策 `maxChecks:1 / maxRequests:0 / maxTokens:0`，额外 provider 费用 0。

## 精确受保护检查及写回

一个 `regression` group，现有受限 VM 中运行 `protected-regression.mjs`。它只对固定临时副本调用一次原始 `node check.mjs`，child timeout 10 秒，完整 restricted check timeout 30 秒，总窗口 5 分钟。原 check 的六项既有用例、原 pass message 和退出 0 都必须成立；执行前后核对候选副本及 baseline 的完整文件名集与四文件哈希。没有修改 check、追加 model 调用或引入依赖。

检查通过后，现有 #25 host 路径重新校验目标 baseline/文件身份/可执行内容，才将已验证 bytes 写回正式目标 clamp.ts。选择固定为 `formal:{writeback:true,activate:null,failureCompensation:'none'}`；不启用新默认或新 build。重开后需要 exact writeback、相同 canonical report、受保护三文件不变、终止和 check receipt 完整，以及 cutoff 后无 provider/budget/model.dispatch 新记录。

失败、取消、超时、记录未知、版本或 baseline 漂移均停止。保留首失败与部分/未知结果，不重试、不续跑、不自动回滚。回滚方法只是未授权预案：另有直接批准时，使用现有 rollbackImproveDecision 并绑定真实 decisionSource/group，只恢复仍匹配本批字节的文件，保护后续用户编辑。原 before bytes 始终保留在原 object store。

## 当前验证范围

`verify-plan.py` 仅检查 JSON/schema 对应字段、文件身份/合法路径、JavaScript 语法和 false/missing 授权入口拒绝。没有导入公共产品 API，没有实际 preview、VM、候选或 protected check 执行。#24/#25 既有产品行为验证在本产品字节未变时复用，不重跑产品测试。

准备检查结果见 `preparation-checks.json`；独立评审仍由协调端记录。本方案的静态检查 PASS 不表示候选效果 PASS。完整 improve 技术验收、日用接受等未完成责任保持原状态。

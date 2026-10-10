# improve-only 批次 harness 修订 r2

当前状态：**r2 已冻结，等待独立 harness 复审与新的单次启动授权**。没有真实 grant、paid-start、凭据读取、provider 调用、产品执行或 VM 启动。

## 两项修复

r1 manifest `9a948eb693a20f5ca4d17443152fff0639465160628432d8d1f2eaa6b8cb1f8e` 及其 368 个文件保持原字节。独立探针确认：最终累计账本保存或读回失败时，r1 会保留 `AWAITING_ACTUAL_CANDIDATE_SELECTION` 并退出 0。该候选保留为失败版本，不可作为本次启动依据。

r2 在这两条异常路径输出 `STOPPED_BUDGET_RECEIPT_FAILURE`、`budgetCompleteness=unknown` 和退出码 1，保留已取得的 analysis、reopened report、paid-start、候选计数及具体账本错误。失败不授予补跑或候选执行权限；没有把已存在候选改写为零，也没有把预算未知解释为已知。

授权来源记录新增 `author="human-user"`、`source.kind="codex-user-reply"` 和非空 `source.requestToolCallId`，连同原 exact reply、receivedAt、manifest 和预算边界由 `authorizationSource` 的文件 hash 绑定。协调者必须从本轮直接人类回复采集真实内容和本轮授权提问的实际 call ID。模板的 call ID、回复、时间保持 null，grant 保持 false。字段检查用于来源审计，不是独立身份认证系统。

## 身份、范围与预算

产品仍为 integrated candidate `f26ae8f4b8039608a1fa796e1c69da4d8173d112`，repair producer `78130b154fe8dad9097c05afb24ff9d1d24d8bce`，source-build `8f4ce2a273559d871b76c1cf14971a0df048d7f86b8216ff45b3d8dd2a710821`。独立产品 review 和旧 PASS 适用性 gate 保持原 PASS，旧执行身份仍为 `9aed1af`。

本次仅一次 improve analysis：batch `pi-durio-v1-live-r3-improve-repair`、request `v1-live-r3-improve`；原 fixture、原 synthetic seed 及模型配置不变，296 个 seed 文件独立复制到 r2 dataRoot。没有 paid eval、候选验证、激活、选择或写回。

| 项目 | 已发生及保留 | 新阶段上限 | 累计上限 |
| --- | ---: | ---: | ---: |
| 物理 host requests | 34 | 8 | 42 |
| known tokens | 61,560 | — | — |
| UNKNOWN reservation | 1,056,768 | — | — |
| charged tokens | 1,118,328 | 1,200,000 | 2,318,328 |
| 保守 USD 估计 | 1.3419936 | 1.44 | 2.7819936 |

`maxRequestTokens=1,056,768`、`maxOutputTokens=8192`、`maxDurationMs=300000` 不变。旧 UNKNOWN 的 raw 952 仍仅作故障证据，不替换历史 host 账本。新 unknown、失败、鉴权错误、取消、超时、超额或最终回执不完整均停止，不自动重试。新 one-start 必须在批准后 24 小时内启动，从实际 startedAt 起最多 60 分钟；旧授权不可复用。

## 验证与保留

新增 8 个 exact-source 内存用例 PASS：最终账本 write/readback 两条异常，各自保留结果且退出 1；缺失/错误 author、source、requestToolCallId 六条拒绝路径，在安装、产品调用和凭据访问前失败。内存替身没有生成实际授权、paid-start 或候选执行。

新增 author/source 后，完整 30 个 exact-source admission 测试已重新通过；新增 8 个用例单独覆盖两项修复。`launch.py`、`common.mjs`、`ledger.mjs` 字节不变，旧 wrapper 和凭据 parser 检查继续适用。复用范围与 hash 见 `check-reuse.json`。旧 r1 两个准备阶段首败、独立 `BUG_REPRODUCED` 探针、原 r2 multi-file error/unknown、r3 improve 0 候选/incomplete 和旧 UNKNOWN 均保留。

即使未来 analysis 返回候选，仍需精确 report/revision/candidate、baseline 和保护范围供人类选择；本次 paid grant 不会选择未知候选。

外部完整证据：`/Users/nineofour/pi-durio-v1-run/evidence/issue-30/improve-only-repair-r2`。旧 7,264 项闭合证据及旧代码身份继续按 hash 检查；冻结 manifest 已绑定独立 r1 FAIL、修复探针、限定复用及新检查。

最终 manifest SHA256：`c1a3904f047ff3c19b16ba7c7e66dc57316f2ff9ad08a7080791ee5babe5fb2a`（76,288 bytes）。完整最终 preflight 使用仅在内存的授权替身，核对 7,320 项实际引用后 PASS；false-pinned grant、missing grant、exact-wrapper missing grant 三入口均按要求拒绝。总计 42 个本轮离线检查通过（30 + 8 + 1 + 3），没有把内存来源字段提升为真实人类授权。具体身份见 `checks.json`。

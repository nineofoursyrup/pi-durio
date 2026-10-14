# improve 输出合同输入修订 r1

**已冻结，等待独立 review 和新的直接人类 one-start 授权。** 没有真实 grant、paid-start 或 authorized-plan；准备过程没有读取凭据、调用 provider、执行产品、启动 VM 或操作候选。

## 本次变化

固定 manifest SHA256：`809aa5350c2d1d3cd3fac9281210ce41e2ff643e889a565bd15f25ae02e30856`（77,149 bytes）。batch `pi-durio-v1-live-r4-improve-report`，request `v1-live-r4-improve`，新的 `improve-data` 包含独立复制的原始 296 文件 synthetic seed。

唯一用户输入变化是 `purpose.txt`，已由协调者确认完整原文，SHA256 `adad8464a3cc3c68d128d852230b4eed1a90c1323b7582740d37c1310eec07cd`（含末尾换行 1,524 bytes）。它明确要求严格单个 JSON、零或一份有证据支持的最小项目修复提案；缺失/withheld 证据进入 gaps，不能包装成空 steps/checks 的候选或作为已取得正文引用；successCounterexamples 需有依据并区分静态推断和执行观察。

`activation.writeback` 仅描述未来意图：适当的项目修复可以声明 true，但必须以之后的明确人类选择和 protected validation 通过为条件，不授予当前写入权限。purpose 没有给出预期修复公式或答案，也没有提供先前 raw 草稿供拼接。

产品 integrated candidate 仍为 `f26ae8f4b8039608a1fa796e1c69da4d8173d112`，producer `78130b154fe8dad9097c05afb24ff9d1d24d8bce`，source-build `8f4ce2a273559d871b76c1cf14971a0df048d7f86b8216ff45b3d8dd2a710821`。安装、validator、模型配置、原 fixture、allowed source 注册与保护文件不变，不重新打包、安装或运行产品测试。本批只做一次未来 improve analysis，没有 paid eval、候选选择/执行/验证/激活/写回。

## 累计预算和两层历史

| 项目 | 已发生及保留 | 新阶段上限 | 累计上限 |
| --- | ---: | ---: | ---: |
| host requests | 41 | 8 | 49 |
| known tokens | 106,026 | — | — |
| UNKNOWN reservation | 1,056,768 | — | — |
| charged upper tokens | 1,162,794 | 1,200,000 | 2,362,794 |
| USD 保守估计 | 1.3953528 | 1.44 | 2.8353528 |

累计保守估计仍小于 USD 3，不是账户账单或平台硬限额证明。单请求 reservation 上限 `1,056,768`、输出 `8192`、单次 analysis `300000 ms`；新 grant 后 24 小时内启动，活动截止为实际 startedAt 后 60 分钟。任一新 unknown、鉴权失败、取消、超时、超额、报告失败或最终账本失败均停止；不自动补跑。

manifest 的 `prior` 保留原 r2/r3 coding 及 improve 证据链，四类 coding PASS 继续标记原执行候选 `9aed1af`；原 multi-file error/unknown 和 r3 UNKNOWN 均保留。`previousImprove` 另行绑定最近已结束的 improve-only-repair-r2：manifest `c1a3904f...e5fb2a`、累计账本 `70ed19f4...eadc28`、真实 grant/来源/paid-start、原 incomplete 报告、reopened、postrun 和 12,074 项读回清单。新账本从最新的 41 次/106,026 known 起算，旧 UNKNOWN 仍为 1,056,768，不使用 raw 952 替代。

上轮 7 条完整 SSE 与 host known 结算通过，但正式报告因输出格式和内容不满足合同而保留 incomplete / 0 candidates。原文内的两份提案始终是未接受文本；本修订不删除、修改或提升它们，不把去围栏当作报告修复。详细原始失败及诊断按实际 hash 绑定，含诊断 helper 首次失败。

## 新授权与检查

新授权须绑定本 manifest、最新 prior manifest/ledger、新 batch/limits，且时间晚于最新批次结束 `2026-10-10T09:45:37.085Z`。来源须为 `author=human-user`、`source.kind=codex-user-reply`，带本轮实际授权提问的非空 `requestToolCallId` 和原始回复/时间；由 main 从直接人类回复采集。旧 r2 grant、kind、来源及较早预算均拒绝。现有文件只有 false/null 模板，purpose 的实现确认不构成付费批准。

新增 16 个离线检查 PASS：12 个受影响 exact-source 内存用例，1 个带内存授权的完整 frozen-input preflight（12,110 项实际引用），以及 3 个真实 false/missing/exact-wrapper missing grant 拒绝入口。没有原样重跑旧 42 项；不变的执行、取消、最终账本异常及来源字段行为按 `check-reuse.json` 限定复用。`common.mjs`、`launch.py`、`ledger.mjs` 字节不变，runner 只把 paid-start 的 priorBudget 指向最新已结束账本。

全部冻结引用、JSON、Python AST、Node syntax 通过；原 12,074 项身份再次一致。内存替身没有建立真实授权或真实候选结果。独立新 review 仍 PENDING，后续实际 report/revision/candidate 的人类选择另行进行。

外部完整目录：`/Users/nineofour/pi-durio-v1-run/evidence/issue-30/improve-output-contract-r1`。仓库副本只用于审阅，真实执行必须使用外部冻结身份，且需新的直接人类授权。main 的 publication 快照不属于本 manifest 的检查或输入。

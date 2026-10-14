# 最终候选 native 定向补跑：技术流程完成

候选 `9aed1af6ee3b156bb7354961496217aa5e64843e`；补跑 `2026-10-10T05:51:08.877Z` 至 `2026-10-10T05:51:42.256Z`，总体 **MEASURED**。`composition` 为 **PASS / exit 0**，`readonly-data` 为 **MEASURED / exit 0**；两步 TTY 前后相同，`ttyRepairNeeded=false`，无未运行步骤。原首批 **MEASURED_WITH_FAILURES** 与 `IMPROVE_REPORT_NOT_FOUND` 原件继续保留；本次仅补失败组合及未运行的只读部分，未重复三个 idle 和原 60+2 任务。#31 整体技术验收仍为 **PARTIAL**。

配置 SHA-256 `e4be939ec2e27357db9e081fe1613f992d55fdeb1083905c38b4d1417d8a9132` 与冻结配置一致。Node `v26.8.2`，实际 `Apple_Terminal` 环境版本 `488.7`、112×35、profile `UNKNOWN`。本批记录一分钟 load average 7.711426–9.471191。原安装身份、sourceBuild、修复 harness 和原成功 long-session 均有内容引用；本次只读回核未启动产品或重新 build。

## 组合流程实际结果

- 原始 90,000 个 z 响应完成且原文 object hash 回读一致；`compaction.finished` 为 `applied`，committed summary 与 `/compactions` frame 保留。
- improve 报告 `native-composition-analysis` 为 `complete`，1 个候选，默认 `selected=[] / unselected`。报告 revision `0d9bc520d4c7d38ccc3cbe10d9fc69aa1a2e89ed81f1f9b3c34778805dfd8f8e` 与提交的选择一致。
- 自动按键依次为 `e`、`s`、一次 Enter，分别记录于 `2026-10-10T05:51:24.011Z`、`2026-10-10T05:51:25.020Z`、`2026-10-10T05:51:26.040Z`；unselected / execute-declared-scope / summary / result frame 均存在。它们是 harness 的 fixture 操作，不是人类选择或日用接受。
- 决定 `native-composition-choice` 和 group 均 `completed`。实际隔离回归执行了 `add(2,3)===5`、`add(-2,3)===1`；execution `started=true / terminated=true / code=0 / modelRequests=[]`，`effect=direct-checks-passed`。保留的 configuration 是 linux/arm64、只读 root、1 CPU、512 MiB，记录 `unshare --net` 及降权/限制程序；stop、delete、absence 控制均退出 0，absence 中不再包含该 execution ID。所有事实来自已经结束的原运行文件，本次未运行隔离环境。
- `allChecksPassed=true`、`requiredBenefitCount=0`、`allRequiredBenefitsMet=true`；同时保留 `allDeclaredBenefitsMet=false`。这里有指定功能回归结论，没有性能收益或候选独立因果贡献结论。
- 正式 fixture 写回为 `written`，activation 为 `not-enabled`；仅本批 fixture 的 `math.mjs` 从减法变加法。before SHA-256 `577b3f8de17b0a06f131cead8e49b2171e17126f0c074581047992a5f45427ba`，after `a94468f11b9e176ff2b3cf31080d67c2a31efc3dc4c0757abf90585f4e765f6a`；当前文件与 after 一致，README 未改变，产品源码不是写回目标。
- 下一普通 read 任务 `f5c3e9b5-7f5f-4a5c-8462-f295385b20dc` 为 `completed`，实际 `tool.result` 已读到 `export const add=(a,b)=>a+b;`。
- 本组合共 **7 次 synthetic requests / 0 次 real provider requests**。正常退出宽度校准 `measured`，245 个 profile entries，blockedFrames=25、retainedInputs=2、pendingInputs=0。

14 份 frame 文件保留了 112×35 的 `app.screen()` 文字和阶段状态；它们来自实际 ProcessTerminal 路径，没有另行取得外部像素截图。本记录不新增 IME、复制、鼠标、小窗口或主观可用性结论。

## 原 native 长会话数据的只读访问

| API | 次数 | 时长 min / median / max ms |
| --- | --- | --- |
| queryHistory | 10 | 11.486834 / 11.952375 / 14.216916 |
| queryEvidence | 10 | 0.446292 / 0.493833 / 0.608500 |
| readEvidence | 10 | 0.678750 / 0.765458 / 1.128333 |

共 30 次查询，核对了 history limit 10、evidence limit 20、decoded evidence limit 1024 bytes。5 次完整输出导出均为 **1,048,576 bytes**，SHA-256 均为 `8e3c8e0abdb626d27f3982beafe83f34f2141c86223bd1b4d3cce74a77181502`，并从实际导出文件回读验证。导出 min / median / max 为 7.961625 / 8.404875 / 9.781375 ms。

`sourceUnchanged=true`，完整 source-before / source-after inventory 的 3067 项逐项一致。导出是公开 bounded read API 组合的全量获取，不宣称 CLI export 提供整轮二进制导出。计时包含枚举、验证读取、解码与写入至 close；未清 OS cache、未 fsync，也未单独测 tracing 或磁盘延迟。

## 证据关系与剩余边界

首批 [原始失败](/Users/nineofour/pi-durio-v1-run/evidence/issue-31/final-9aed1af/native/result.json) 和 [首批报告](/Users/nineofour/pi-durio-v1-run/evidence/issue-31/final-9aed1af/native-report.md) 不改变；补跑 [result](/Users/nineofour/pi-durio-v1-run/evidence/issue-31/final-9aed1af/native-followup-r1/result.json)、[独立摘要](/Users/nineofour/pi-durio-v1-run/evidence/issue-31/final-9aed1af/native-followup-r1-summary.json) 给出新的结果与绝对路径/hash。后续报告、当前 fixture、隔离 outcome/cleanup、查询及全部导出都有引用，未复制大 raw payload。

单独的 #30 [batch-result](/Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af-usd3-r2/batch-result.json) 已记录 `2026-10-10T05:54:47.608Z` **STOPPED**，原因为 `Error: BATCH_TRIAL_NOT_PASS`；#30 仍 incomplete，真实 improve 闭环尚未完成。付费诊断及计费证据由 #30 单独归档，本报告不展开或补跑。完整 contract 适用性结论与 #32 日用接受亦分别待完成。

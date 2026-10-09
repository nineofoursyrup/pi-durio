# r6 原生补验

产品候选 `231f206e859f0ed889a69d943b9c17f92a20cf79`；集成 merge `f17ddfbe9fb8b07a6ddde46a42cb35560b07687c`。候选、manifest 和 runner 冻结；人工日志独立追加。

首次场景操作只收到两次 Ctrl+D（783ms）、没有请求输入。人填 P、raw/stty 恢复；其实际范围是空闲首次双按退出，不能当作运行中退出：[原样评分与有限结论](terminal-r6-idle-d-partial.json)。

随后重新提交 Read README 并等待运行，再首次双按 Ctrl+D（516ms）。用户填 P；原始键码为 0x04，中间只有终端校准协议回包；runtime 记录 intent exit、resumable、cleanup confirmed，raw/stty 恢复，同一 run 的 headless 结果一致：[本项读回](terminal-r6-exit-first-pair.json)。remoteTermination unknown 保持原值，不从本地清理推断远端结束。

后续原生观察又完成三项补验：

- 空闲首次 Ctrl+C 两次相隔 589ms，人工 P；保存的草稿原文为 `keep this draft`，零请求、raw/stty 恢复：[读回](terminal-r6-idle-c-first-pair.json)。
- 可捕获测试故障人工 P；错误为预期的 `TERMINAL_VALIDATION_CAPTURED_FAULT`，cleanup confirmed、raw/stty 和同 run headless 一致；原任务 unknown/resumable 保持：[读回](terminal-r6-fault.json)。
- 正常完成 S1 和更小窗口恢复 S3 均人工 P；实际结果 completed、`Fruit count: 7`、cleanup confirmed、raw/stty 和 headless 一致。S2 填 U 并说明“忘了看 xyz”，minimumGrid 也填 U。日志虽在 40×12 收到 xyz/F2/Esc，不能据此推断视觉可用或最小尺寸通过：[部分读回](terminal-r6-supplement-partial.json)。

只剩 S2 的明确尺寸输入/菜单视觉观察待补，已准备只测该项的外部入口。r5 的原 EXIT F、本轮 S2 UNKNOWN 和所有旧记录不改写。此前适用证据及 OS 窗口焦点附加探查 UNKNOWN 见 [修复适用性说明](confirmation-repair-r6.md)。#16 未完成验收，不解锁后续票。

## 最小尺寸补充确认

单项 GRID_INPUT 已由用户填 P，日志在同一 40×12 尺寸记录完整 xyz→F2→Esc，零任务请求、raw/stty 恢复且无校准错误。尺寸字段误填 P 的原件及 UNKNOWN 汇总保持原样。用户随后明确补充“确认，是 40×12，文字和菜单都正常”，独立绑定于本次记录：[补充确认](terminal-r6-grid-confirmation.json)。因此已实测确认本环境下 40×12 可完成输入与菜单操作。

#16 的适用验收现已满足，可解锁内部后继依赖；原 Issue 保持 OPEN。[候选与完整验收索引](acceptance-r6.md)。此前段落描述的是当时的未完成状态，历史 F/U 和原文件均保留。

# r6 原生补验

产品候选 `231f206e859f0ed889a69d943b9c17f92a20cf79`；集成 merge `f17ddfbe9fb8b07a6ddde46a42cb35560b07687c`。候选、manifest 和 runner 冻结；人工日志独立追加。

首次场景操作只收到两次 Ctrl+D（783ms）、没有请求输入。人填 P、raw/stty 恢复；其实际范围是空闲首次双按退出，不能当作运行中退出：[原样评分与有限结论](terminal-r6-idle-d-partial.json)。

随后重新提交 Read README 并等待运行，再首次双按 Ctrl+D（516ms）。用户填 P；原始键码为 0x04，中间只有终端校准协议回包；runtime 记录 intent exit、resumable、cleanup confirmed，raw/stty 恢复，同一 run 的 headless 结果一致：[本项读回](terminal-r6-exit-first-pair.json)。remoteTermination unknown 保持原值，不从本地清理推断远端结束。

这仅使 EXIT_FIRST_PAIR 通过；空闲 Ctrl+C 草稿、可捕获故障、正常 completed 及最小窗口仍待补。r5 的原 EXIT F 和所有旧记录不改写。此前适用证据及 OS 窗口焦点附加探查 UNKNOWN 见 [修复适用性说明](confirmation-repair-r6.md)。#16 未完成验收，不解锁后续票。

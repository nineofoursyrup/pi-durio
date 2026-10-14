# #16 实际 Terminal 宽度诊断

#16 状态仍为 `integrated-terminal-failed`，r3/r4 原始 FAIL 均保留。用户于 2026-10-09 在自己的 macOS Terminal 运行已冻结诊断，得到 `CARET_MISMATCH_REPRODUCED`。诊断没有调用模型或业务工具，raw/stty 均恢复。

源报告：`evidence/issue-16/width-repair/manual/2026-10-09T11-36-26-097Z/report.json`，SHA-256 `64fdf16badff4653bd224b3bbd9ec7bedcbe3d07554ea063f8b44de578f7f1b3`。本目录的 `terminal-width-report-r4.json` 为该报告的逐字节副本。

实际环境：Apple_Terminal 488.7、macOS 27.2 build 26B5101f、arm64、Node v26.8.2、zh_CN.UTF-8、100×30。

| 输入 | Terminal CPR 格宽 | Pi 1.1.0 格宽 |
| --- | ---: | ---: |
| AB | 2 | 2 |
| 中 | 2 | 2 |
| é | 1 | 1 |
| 👩 / 💻 | 各 2 | 各 2 |
| 👩‍💻 | 5 | 2 |
| A👩‍💻é中B | 10 | 7 |
| A👩‍💻é中B。 | 12 | 9 |

完整串自然末列为 11，r4 已记录的 ANSI 将 caret 定位至列 8；报告保留两次实际 CPR 回应。用户也确认直接自然输出仍有 emoji 后间隙。由此能证明当前 Terminal 与 Pi 的该字符格宽不匹配，不能推导所有环境或所有 emoji 都应加 3，也不能声称宿主修复能改变 Terminal 字形外观。

精确 Pi 1.1.0 的 Editor、换行、caret、鼠标选文与列切片共用内部宽度计算，目前没有公开配置入口。外部提案副本为该接缝增加实测映射配置，已对上述真实样本验证光标/换行/选文同时修正；新输入字符的校准生命周期仍需确定。提案未接入产品，依赖和锁文件未变。

总规格 A5 要求只能维护 fork 或更换核心依赖时停止受影响路径并重开相应决策。该例外尚未获准；#17/#18 不解锁，最终真人验收不由离线提案替代。

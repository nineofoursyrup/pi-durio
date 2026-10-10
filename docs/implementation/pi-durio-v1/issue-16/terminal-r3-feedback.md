# #16 r3 人工验收反馈

候选 `004266e9e6c1a3b639a44c31096511efe71c5d61`；固定安装、manifest、runner、原始人工记录保留。真人反馈不能被模拟测试覆盖。

- 用户在当前 chat 报告光标消失、闪烁或出现多个光标：FAIL，已派独立工作树排查与修复。
- 人工脚本 normal 观察：中文输入法候选 Enter PASS；emoji 与中文之间的 `é` 相关操作 FAIL（具体触发尚未明确）；忙时 Enter UNKNOWN；输出滚动与焦点 PASS。
- 机器记录两次 normal、一次 stop 的 raw/stty 恢复为 true；第二次 normal 有一次复制的 pbpaste 字节读回一致。这些机器事实不证明其他人工标准。
- 观察中误粘贴的 fixture 原文不作为验收结论；完整原文不改动。
- #16 保持 integrated-terminal-failed；#17/#18 依赖未满足。修复将创建新候选，r3 不覆盖。

本地事实源：`/Users/nineofour/pi-durio-v1-run/evidence/issue-16/user-feedback-r3.json`、`human-observation-r3-derived.json` 与其引用的 manual 目录。不是 #32 日用接受，也未运行付费 provider。

追加澄清：用户明确 `é` 是“没能输入或粘贴出”，因此保留原观察但暂不推定编辑器缺陷；该组合字符路径待用可复制文本 `A👩‍💻é中B` 复测。

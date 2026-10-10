# pi-durio v1 实施状态

产品候选：`9aed1af6ee3b156bb7354961496217aa5e64843e`；分支：`codex/pi-durio-v1`；[Draft PR #33](https://github.com/nineofoursyrup/pi-durio/pull/33)。后续文档提交单独保留身份，不把安装包改标成新产品候选。

19 张票（#11–#29）已集成并通过本票适用验收；#30 已完成一次真实付费启动，但在第二个案例达到单任务 8 次请求上限后停止，真实 improve 未运行。#31 已完成计划中的原生 Terminal 技术测量及定向补测，整体仍因 #30 未完成而为 PARTIAL；#32 尚未试用和接受。全部 Issue 保持 OPEN，main 产品合并及 release 未执行。

固定候选独立 Spec / Standards 的受影响复审均 PASS，硬问题为 0，保留 2 个可选 smell。原组合测试 **251 / 250 PASS / 1 FAIL** 保持原记录；当前采用有内容身份和适用性说明的旧检查复用，加截止时间/取消及受影响真实 VM 路径验证，没有新全套 PASS 声明。

- [Spec 评审](review/9aed1af/spec-review.md) · [Standards 评审](review/9aed1af/standards-review.md) · [当前检查 gate](review/9aed1af/applicable-check-gate.json)。
- [本地测量](issue-31/final-9aed1af/partial-report.md) · [原生 Terminal 首批](issue-31/final-9aed1af/native-report.md) · [定向补测](issue-31/final-9aed1af/native-followup-r1-report.md) · [原合同索引](issue-31/final-9aed1af/contract-evidence-index.md)。
- [安装及 npm 兼容性限制](delivery-9aed1af/npm-diagnosis-REPORT.md) · [完整交付边界](delivery-9aed1af/README.md)。

| 票 | 实际状态 | 前置票 | 主要证据 / 未完成项 |
| --- | --- | --- | --- |
| [#11](https://github.com/nineofoursyrup/pi-durio/issues/11) 首个 headless 只读任务与持久记录 | 本票适用验收完成 | 无 | [证据](issue-11/README.md) |
| [#12](https://github.com/nineofoursyrup/pi-durio/issues/12) 受限执行与可信评分探查 | 本票适用验收完成 | 无 | [证据](issue-12/report.md) |
| [#13](https://github.com/nineofoursyrup/pi-durio/issues/13) 可写 coding、工作区所有权与完整输出 | 本票适用验收完成 | #11 | [证据](issue-13/README.md) |
| [#14](https://github.com/nineofoursyrup/pi-durio/issues/14) 中止与退出的可解释收尾 | 本票适用验收完成 | #13 | [证据](issue-14/README.md) |
| [#15](https://github.com/nineofoursyrup/pi-durio/issues/15) 只读重开与恢复核对 | 本票适用验收完成 | #14 | [证据](issue-15/README.md) |
| [#16](https://github.com/nineofoursyrup/pi-durio/issues/16) 真实 Terminal 请求往返与可靠输入 | 本票适用验收完成 | #11 | [证据](issue-16/README.md) |
| [#17](https://github.com/nineofoursyrup/pi-durio/issues/17) 忙时队列、停止与恢复决策交互 | 本票适用验收完成 | #16, #15 | [证据](issue-17/README.md) |
| [#18](https://github.com/nineofoursyrup/pi-durio/issues/18) 历史原文、trace、用量追查与固定证据 | 本票适用验收完成 | #13, #16 | [证据](issue-18/README.md) |
| [#19](https://github.com/nineofoursyrup/pi-durio/issues/19) 自动与主动上下文压缩 | 本票适用验收完成 | #18, #17 | [证据](issue-19/README.md) |
| [#20](https://github.com/nineofoursyrup/pi-durio/issues/20) 保留保护下的归档、清理与一致性迁移 | 本票适用验收完成 | #15, #18 | [证据](issue-20/README.md) |
| [#21](https://github.com/nineofoursyrup/pi-durio/issues/21) 固定计划下的受预算 eval 与独立评分 | 本票适用验收完成 | #18, #12, #15 | [证据](issue-21/README.md) |
| [#22](https://github.com/nineofoursyrup/pi-durio/issues/22) fresh 对照与限定范围改善报告 | 本票适用验收完成 | #21 | [证据](issue-22/README.md) |
| [#23](https://github.com/nineofoursyrup/pi-durio/issues/23) improve 受限取证与候选报告 | 本票适用验收完成 | #17, #18 | [证据](issue-23/README.md) |
| [#24](https://github.com/nineofoursyrup/pi-durio/issues/24) improve 结构化选择、仅验证与建议抑制 | 本票适用验收完成 | #22, #23 | [证据](issue-24/README.md) |
| [#25](https://github.com/nineofoursyrup/pi-durio/issues/25) 项目与配置候选的验证后写回、启用和回退 | 本票适用验收完成 | #24 | [证据](issue-25/README.md) |
| [#26](https://github.com/nineofoursyrup/pi-durio/issues/26) 自身源码新构建与独立 eval 资产改进 | 本票适用验收完成 | #25 | [证据](issue-26/README.md) · [截止时间修复](issue-26/deadline-repair-r1.md) · [复审](review/9aed1af/standards-review.md) |
| [#27](https://github.com/nineofoursyrup/pi-durio/issues/27) 任务验收三率与执行、验收双时钟 | 本票适用验收完成 | #17, #18 | [证据](issue-27/README.md) |
| [#28](https://github.com/nineofoursyrup/pi-durio/issues/28) 全样本成本与任务、尝试故障报告 | 本票适用验收完成 | #27 | [证据](issue-28/README.md) |
| [#29](https://github.com/nineofoursyrup/pi-durio/issues/29) 低打扰人工介入与交付后返工报告 | 本票适用验收完成 | #27 | [证据](issue-29/README.md) |
| [#30](https://github.com/nineofoursyrup/pi-durio/issues/30) 真实 DeepSeek 代表任务与 improve 执行闭环 | 首次付费批次 STOPPED，未完成 | #25 | local-fix PASS；multi-file 未完成；regression/no-change 和真实 improve 未运行。保留首次失败，追加启动需具体批次授权 |
| [#31](https://github.com/nineofoursyrup/pi-durio/issues/31) 首版技术验收与轻量实测报告 | 原生技术批次已补齐，整体 PARTIAL | #19, #28, #29, #26, #20, #30 | [定向补测与边界](issue-31/final-9aed1af/native-followup-r1-report.md)；待 #30 及完整技术验收 |
| [#32](https://github.com/nineofoursyrup/pi-durio/issues/32) 本机试用与明确日用接受 | 未运行，等待 #31 | #31 | 需用户在自己的 Mac 实际试用并明确接受；agent 不代答 |

完整 per-ticket worktree、原票 commit、集成 SHA、修复链、原始 FAIL/UNKNOWN 和证据路径见 `status.json`。本票验收只满足内部任务图的适用条件，不替代全产品真实调用、技术验收或用户接受。

真实批次 `51ff05f1…` 已消费一次启动：15 次 HTTP 请求、27,499 个已知 token；按固定最高单价计算约 USD 0.0329988，这是 token 价目估算，未读取账户账单。四个计划案例中 started=2 / completed=1 / gradable=1 / passed=1；完成率及覆盖率均为 25%，不能将一个已评分案例的 PASS 外推整批通过。宿主 budget 是计费统计依据，guest 镜像用量不重复计入。

原生首批三个 idle 和 60+2 个任务测量完成；组合步骤因 harness 在异步报告生成前读取而失败，原件保留。定向补测只修复该轮询，并完成 compaction、合成 improve 选择、隔离回归、fixture 正式写回、下一任务读取，以及 30 次查询和 5 次 1 MiB 完整导出。它们不代替真实 improve 或 #32 人工接受。

当前前沿：完成 #30 首失败诊断并准备新的具体付费批次，再请求新的一次启动；原 USD 3 上限和许可凭据来源继续沿用，实际未来 improve 候选仍须用户具体选择。原批次禁止自动重复，#31/#32 不能提前记为完成。

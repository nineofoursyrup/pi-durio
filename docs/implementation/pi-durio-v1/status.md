# pi-durio v1 实施状态

产品候选：`9aed1af6ee3b156bb7354961496217aa5e64843e`；分支：`codex/pi-durio-v1`；[Draft PR #33](https://github.com/nineofoursyrup/pi-durio/pull/33)。后续文档提交单独保留身份，不把安装包改标成新产品候选。

19 张票（#11–#29）已集成并通过本票适用验收；#30 已准备但尚无真实付费执行，#31 只有部分技术证据，#32 尚未试用和接受。全部 Issue 保持 OPEN，main 产品合并及 release 未执行。

固定候选独立 Spec / Standards 的受影响复审均 PASS，硬问题为 0，保留 2 个可选 smell。原组合测试 **251 / 250 PASS / 1 FAIL** 保持原记录；当前采用有内容身份和适用性说明的旧检查复用，加截止时间/取消及受影响真实 VM 路径验证，没有新全套 PASS 声明。

- [Spec 评审](review/9aed1af/spec-review.md) · [Standards 评审](review/9aed1af/standards-review.md) · [当前检查 gate](review/9aed1af/applicable-check-gate.json)。
- [本地测量](issue-31/final-9aed1af/partial-report.md) · [62 合同 / 22 ACC / 7 MET 索引](issue-31/final-9aed1af/contract-evidence-index.md)。
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
| [#30](https://github.com/nineofoursyrup/pi-durio/issues/30) 真实 DeepSeek 代表任务与 improve 执行闭环 | 准备完成，真实调用未运行 | #25 | [证据](issue-30/final-9aed1af/authorization-request.md)；需当前 manifest 的付费授权、凭据来源及实际候选另行选择 |
| [#31](https://github.com/nineofoursyrup/pi-durio/issues/31) 首版技术验收与轻量实测报告 | 部分技术证据，未完成验收 | #19, #28, #29, #26, #20, #30 | [证据](issue-31/final-9aed1af/partial-report.md)；待 #30、最终原生 Terminal 及完整技术核对 |
| [#32](https://github.com/nineofoursyrup/pi-durio/issues/32) 本机试用与明确日用接受 | 未运行，等待 #31 | #31 | 需用户在自己的 Mac 实际试用并明确接受；agent 不代答 |

完整 per-ticket worktree、原票 commit、集成 SHA、修复链、原始 FAIL/UNKNOWN 和证据路径见 `status.json`。本票验收只满足内部任务图的适用条件，不替代全产品真实调用、技术验收或用户接受。

当前外部前沿：用户已收到 [USD 5 以内固定真实批次的授权请求](issue-30/final-9aed1af/authorization-request.md)及 [macOS Terminal 启动命令](issue-31/final-9aed1af/native-request.md)。没有收到授权或结果前保持 NOT RUN，不自动重新生成批次、使用凭据或选择未知候选。

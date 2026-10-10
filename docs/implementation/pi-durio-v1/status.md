# pi-durio v1 实施状态

产品候选：`f26ae8f4b8039608a1fa796e1c69da4d8173d112`；分支：`codex/pi-durio-v1`；[Draft PR #33](https://github.com/nineofoursyrup/pi-durio/pull/33)。新候选有独立构建/安装身份；旧真实调用和 native 测量保留 `9aed1af` 的执行身份，后续文档提交另行记录。

19 张票（#11–#29）完成本票适用验收。真实 improve 暴露的 LIVE-USD3-R3-01 已完成本地修复、受影响检查与独立复核；原真实失败和 UNKNOWN 保留。四类 coding 场景各有分批真实 PASS，经独立读回可在限定范围复用；当前候选的 output-r1 分析完成 4 次请求且全部 known、cleanup confirmed，正式 report complete，生成 1 个未选择候选；原推理错误已披露，实际选择/验证/写回仍待完成。#31 有 native 行为的限定复用和新体积实测，整体 PARTIAL；#32 尚未试用和接受。全部 Issue OPEN，main 产品合并及 release 未执行。

新候选的独立 Standards / Spec 修复复核均 PASS：0 硬问题，1 非阻塞命名建议；旧评审及其可选建议保留历史范围。最终 boundary 11/11、Pi runtime 2/2、7 块原始响应离线重放 952→7 通过。独立适用性读回另确认四类旧 PASS 的 25 个响应及 3 个 native 合成预算响应与新 parser 一致。原组合 **251 / 250 PASS / 1 FAIL** 保持原记录，未改检查继续按内容身份和适用性复用，没有新全套 PASS 声明。

- [当前独立 Standards / Spec 评审](review/f26ae8f/review.md) · [当前检查 gate](review/f26ae8f/applicable-check-gate.json) · [旧证据适用性](review/f26ae8f/evidence-applicability.json)。
- [本地测量](issue-31/final-9aed1af/partial-report.md) · [原生 Terminal 首批](issue-31/final-9aed1af/native-report.md) · [定向补测](issue-31/final-9aed1af/native-followup-r1-report.md) · [原合同索引](issue-31/final-9aed1af/contract-evidence-index-r2.md) · [当前合同补充](issue-31/improve-output-contract-r1/CONTRACT-DELTA.md) · [新体积实测](issue-31/provider-terminal-repair-r1/MEASUREMENT.md)。
- [真实首批诊断](issue-30/final-9aed1af-usd3-r2/postrun-diagnosis/REPORT.md) · [补充批次结果与诊断](issue-30/final-9aed1af-usd3-r3/postrun-readback/REPORT.md)。
- [安装及 npm 兼容性限制](delivery-9aed1af/npm-diagnosis-REPORT.md) · [当前交付边界](delivery-f26ae8f/README.md)。

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
| [#23](https://github.com/nineofoursyrup/pi-durio/issues/23) improve 受限取证与候选报告 | 本票适用验收完成；回归已修复复核 | #17, #18 | [原证据](issue-23/README.md)；[修复独立复核](review/f26ae8f/review.md) |
| [#24](https://github.com/nineofoursyrup/pi-durio/issues/24) improve 结构化选择、仅验证与建议抑制 | 本票适用验收完成 | #22, #23 | [证据](issue-24/README.md) |
| [#25](https://github.com/nineofoursyrup/pi-durio/issues/25) 项目与配置候选的验证后写回、启用和回退 | 本票适用验收完成 | #24 | [证据](issue-25/README.md) |
| [#26](https://github.com/nineofoursyrup/pi-durio/issues/26) 自身源码新构建与独立 eval 资产改进 | 本票适用验收完成 | #25 | [证据](issue-26/README.md) · [截止时间修复](issue-26/deadline-repair-r1.md) · [复审](review/9aed1af/standards-review.md) |
| [#27](https://github.com/nineofoursyrup/pi-durio/issues/27) 任务验收三率与执行、验收双时钟 | 本票适用验收完成 | #17, #18 | [证据](issue-27/README.md) |
| [#28](https://github.com/nineofoursyrup/pi-durio/issues/28) 全样本成本与任务、尝试故障报告 | 本票适用验收完成 | #27 | [证据](issue-28/README.md) |
| [#29](https://github.com/nineofoursyrup/pi-durio/issues/29) 低打扰人工介入与交付后返工报告 | 本票适用验收完成 | #27 | [证据](issue-29/README.md) |
| [#30](https://github.com/nineofoursyrup/pi-durio/issues/30) 真实 DeepSeek 代表任务与 improve 执行闭环 | 四类场景已有 PASS；improve 未完成 | #25 | [最新真实 improve](issue-30/improve-output-contract-r1/postrun-readback/REPORT.md)：4 请求全部 known，report complete / 1 unselected candidate；原推理错误及旧 UNKNOWN、首败保留；待用户选择 |
| [#31](https://github.com/nineofoursyrup/pi-durio/issues/31) 首版技术验收与轻量实测报告 | 新体积实测及旧 native 有界复用，整体 PARTIAL | #19, #28, #29, #26, #20, #30 | [当前合同补充](issue-31/improve-output-contract-r1/CONTRACT-DELTA.md)；待 #30 及完整技术验收 |
| [#32](https://github.com/nineofoursyrup/pi-durio/issues/32) 本机试用与明确日用接受 | 未运行，等待 #31 | #31 | 需用户在自己的 Mac 实际试用并明确接受；agent 不代答 |

完整 per-ticket worktree、原票 commit、集成 SHA、修复链、原始 FAIL/UNKNOWN 和证据路径见 `status.json`。本票验收只满足内部任务图的适用条件，不替代全产品真实调用、技术验收或用户接受。

真实批次 `51ff05f1…` 已消费一次启动：15 次 HTTP 请求、27,499 个已知 token；按固定最高单价计算约 USD 0.0329988，这是 token 价目估算，未读取账户账单。四个计划案例中 started=2 / completed=1 / gradable=1 / passed=1；完成率及覆盖率均为 25%，不能将一个已评分案例的 PASS 外推整批通过。宿主 budget 是计费统计依据，guest 镜像用量不重复计入。

原生首批三个 idle 和 60+2 个任务测量完成；组合步骤因 harness 在异步报告生成前读取而失败，原件保留。定向补测只修复该轮询，并完成 compaction、合成 improve 选择、隔离回归、fixture 正式写回、下一任务读取，以及 30 次查询和 5 次 1 MiB 完整导出。它们不代替真实 improve 或 #32 人工接受。

当前前沿：output-r1 已按明确授权唯一启动并结束。当前产品 f26ae8f 实际完成 4 次请求、24,585 tokens 全部 known，无新增 UNKNOWN，cleanup confirmed、storage closed；正式 report complete，1 个稳定候选尚未选择、执行或验证。[真实读回](issue-30/improve-output-contract-r1/postrun-readback/REPORT.md)核对实时/重开/持久报告相同；原 r2 输出契约失败及原始证据保留。

原报告 summary 自相矛盾，hypotheses[1]误称旧区间内/超上界案例已通过。[静态说明](review/improve-output-contract-r1-candidate/STATIC-ANALYSIS.md)保留并披露错误；候选提出的clamp.ts内层min→max补丁尚未实际验证。累计45次物理请求，130,611 known tokens加1,056,768旧UNKNOWN预留，保守占额1,187,379 tokens / USD1.4248548；非账户账单，旧raw952不回填或释放预留。

[精确候选执行草稿](issue-30/improve-output-contract-r1/candidate-execution-plan-r1/README.md)及[选择请求](review/improve-output-contract-r1-candidate/selection-request.md)已完成[独立Standards/Spec复核](review/improve-output-contract-r1-candidate/independent-review.md)，均PASS。Manifest `686b5c023020444104cd711b809dfd01442b0568a79fa36e42484716c8f1f3fe`；只含1次原保护回归及通过后的clamp.ts精确写回，0新provider。原报告推理错误不被更正为成功事实；先获得用户实际选择才执行。#30仍未完成，#31 PARTIAL，#32等待用户本机试用和明确接受。

文档及计划准备未改变产品构建/安装、fixture或原分析数据；没有新全套检查或性能结论。旧FAIL/UNKNOWN、评审与修复链保持原范围。

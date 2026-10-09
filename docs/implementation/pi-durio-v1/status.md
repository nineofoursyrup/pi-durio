# pi-durio v1 implementation status

Integration: `codex/pi-durio-v1`; observed tip: `a29a5ecde3ac13615b84a7357783ac8546727822`.
Draft PR: https://github.com/nineofoursyrup/pi-durio/pull/33.

Issues remain OPEN; integrated-accepted means ticket acceptance only, not v1 acceptance or release.

| Issue | Status | Dependencies | Commit | Integrated | Evidence / gap |
| --- | --- | --- | --- | --- | --- |
| #11 首个 headless 只读任务与持久记录 | integrated-accepted | none | 1aa75e99a7660fe00b97a0da54ee6c9370bf272a | b373e1780444b51c913d438a85daec3a00b1b2a1 | docs/implementation/pi-durio-v1/issue-11/README.md, /Users/nineofour/pi-durio-v1-run/evidence/issue-11/merge-integration-readback.json |
| #12 受限执行与可信评分探查 | integrated-accepted | none | 9fb7ca7e5ad51d2abb83646dfabf417f3f5eeba6 | a4a4a08b65a709d3d731749084d51f482516ab5d | docs/implementation/pi-durio-v1/issue-12/report.md, /Users/nineofour/pi-durio-v1-run/evidence/issue-12/merge-integration-readback.json |
| #13 可写 coding、工作区所有权与完整输出 | integrated-accepted | #11 | 9d230e4f2c0eaa3ca771e954bbdf279f6f71176a | ae7454b226f7298cb8f0885e32b071c8b3ed3fe9 | docs/implementation/pi-durio-v1/issue-13/README.md, /Users/nineofour/pi-durio-v1-run/evidence/issue-13/merge-integration-readback.json |
| #14 中止与退出的可解释收尾 | integrated-accepted | #13 | c0350714439dfc272f7c53759129e0dc6d2e182f | 5c3d9c754dc41b0d0bb1fb8e89661a31bbe50fcd | docs/implementation/pi-durio-v1/issue-14/README.md, /Users/nineofour/pi-durio-v1-run/evidence/issue-14/merge-integration-readback.json |
| #15 只读重开与恢复核对 | integrated-accepted | #14 | 057fc9ea5f53c887553ff4a7f1c8ab405856b56e | bb0ba36b1c17743e05ee1765f6c0389bcc6f16ef | docs/implementation/pi-durio-v1/issue-15/README.md, /Users/nineofour/pi-durio-v1-run/evidence/issue-15/merge-integration-readback.json |
| #16 真实 Terminal 请求往返与可靠输入 | integrated-terminal-failed | #11 | aff8b09224780f5938dce311580fc30822fb6ecf | afd14225862bb2339b008f912beff208caf7d579 | /Users/nineofour/pi-durio-v1-run/evidence/issue-16/handoff.json, /Users/nineofour/pi-durio-v1-run/evidence/issue-16/candidate-r3/manifest.json, docs/implementation/pi-durio-v1/issue-16/candidate-r3.json, /Users/nineofour/pi-durio-v1-run/evidence/issue-16/merge-integration-readback.json, /Users/nineofour/pi-durio-v1-run/evidence/issue-16/user-feedback-r3.json, /Users/nineofour/pi-durio-v1-run/evidence/issue-16/human-observation-r3-derived.json, /Users/nineofour/pi-durio-v1-run/evidence/issue-16/cursor-repair/handoff-r4.json, docs/implementation/pi-durio-v1/issue-16/candidate-r4.json, /Users/nineofour/pi-durio-v1-run/evidence/issue-16/cursor-repair/merge-integration-readback.json, /Users/nineofour/pi-durio-v1-run/evidence/issue-16/user-feedback-r4.json, docs/implementation/pi-durio-v1/issue-16/terminal-r4-feedback.json, docs/implementation/pi-durio-v1/issue-16/terminal-width-diagnosis.md, docs/implementation/pi-durio-v1/issue-16/terminal-width-report-r4.json |
| #17 忙时队列、停止与恢复决策交互 | blocked-by-dependencies | #16, #15 | — | — | NOT RUN |
| #18 历史原文、trace、用量追查与固定证据 | blocked-by-dependencies | #13, #16 | — | — | NOT RUN |
| #19 自动与主动上下文压缩 | blocked-by-dependencies | #18, #17 | — | — | NOT RUN |
| #20 保留保护下的归档、清理与一致性迁移 | blocked-by-dependencies | #15, #18 | — | — | NOT RUN |
| #21 固定计划下的受预算 eval 与独立评分 | blocked-by-dependencies | #18, #12, #15 | — | — | NOT RUN |
| #22 fresh 对照与限定范围改善报告 | blocked-by-dependencies | #21 | — | — | NOT RUN |
| #23 improve 受限取证与候选报告 | blocked-by-dependencies | #17, #18 | — | — | NOT RUN |
| #24 improve 结构化选择、仅验证与建议抑制 | blocked-by-dependencies | #22, #23 | — | — | NOT RUN |
| #25 项目与配置候选的验证后写回、启用和回退 | blocked-by-dependencies | #24 | — | — | NOT RUN |
| #26 自身源码新构建与独立 eval 资产改进 | blocked-by-dependencies | #25 | — | — | NOT RUN |
| #27 任务验收三率与执行、验收双时钟 | blocked-by-dependencies | #17, #18 | — | — | NOT RUN |
| #28 全样本成本与任务、尝试故障报告 | blocked-by-dependencies | #27 | — | — | NOT RUN |
| #29 低打扰人工介入与交付后返工报告 | blocked-by-dependencies | #27 | — | — | NOT RUN |
| #30 真实 DeepSeek 代表任务与 improve 执行闭环 | blocked-by-dependencies | #25 | — | — | NOT RUN |
| #31 首版技术验收与轻量实测报告 | blocked-by-dependencies | #19, #28, #29, #26, #20, #30 | — | — | NOT RUN |
| #32 本机试用与明确日用接受 | blocked-by-dependencies | #31 | — | — | NOT RUN |

Provider paid authorization: NOT GRANTED
Human daily-use acceptance: NOT RUN

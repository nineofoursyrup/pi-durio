# pi-durio v1 implementation status

Integration: `codex/pi-durio-v1`; observed product merge: `c99360ff412b51c10041e6cea3a94d7b90213f8d`.
Draft PR: https://github.com/nineofoursyrup/pi-durio/pull/33.

Issues remain OPEN; integrated-accepted means applicable ticket acceptance, not v1 acceptance or release. Full evidence paths and historical failures are retained in status.json and each ticket directory.

| Issue | Status | Dependencies | Commit | Integrated | Evidence / gap |
| --- | --- | --- | --- | --- | --- |
| #11 首个 headless 只读任务与持久记录 | integrated-accepted | none | 1aa75e99a7660fe00b97a0da54ee6c9370bf272a | b373e1780444b51c913d438a85daec3a00b1b2a1 | T01 offline real Pi runtime acceptance passed; source/compiled/evidence/install identities verified. Paid provider NOT RUN. |
| #12 受限执行与可信评分探查 | integrated-accepted | none | 9fb7ca7e5ad51d2abb83646dfabf417f3f5eeba6 | a4a4a08b65a709d3d731749084d51f482516ab5d | Ticket acceptance and merge identity verified. Formal product eval remains #21; issue remains OPEN. |
| #13 可写 coding、工作区所有权与完整输出 | integrated-accepted | #11 | 9d230e4f2c0eaa3ca771e954bbdf279f6f71176a | ae7454b226f7298cb8f0885e32b071c8b3ed3fe9 | T03 local/offline applicable acceptance passed. Source/compiled/evidence identities and original materials verified; complete lifecycle/recovery/Terminal/provider remain later obligations. |
| #14 中止与退出的可解释收尾 | integrated-accepted | #13 | c0350714439dfc272f7c53759129e0dc6d2e182f | 5c3d9c754dc41b0d0bb1fb8e89661a31bbe50fcd | T04 applicable acceptance passed: 44/44 combined checks and 9/9 independent lifecycle cases; all artifacts verified. Real Terminal human gate remains separate. |
| #15 只读重开与恢复核对 | integrated-accepted | #14 | 057fc9ea5f53c887553ff4a7f1c8ab405856b56e | bb0ba36b1c17743e05ee1765f6c0389bcc6f16ef | T05 applicable acceptance passed: 59/59 combined checks, 4/4 standalone recovery cases, 8/8 concurrent startup; exact candidate tree and artifacts verified. Unknown foreign pending/raw crash remains fenced with explicit responsibility. Terminal acceptance remains #16. |
| #16 真实 Terminal 请求往返与可靠输入 | integrated-accepted | #11 | 231f206e859f0ed889a69d943b9c17f92a20cf79 | f17ddfbe9fb8b07a6ddde46a42cb35560b07687c | T06 applicable acceptance complete: inherited unchanged native C/N/STOP/ESC plus r6 first-pair C/D, fault, completed and explicit 40x12 input/menu. Original FAIL/UNKNOWN retained; final v1 acceptance and paid provider remain separate. |
| #17 忙时队列、停止与恢复决策交互 | integrated-accepted | #16, #15 | f67a2edd377d37e3f13bbc0da273028103695d6f | cc8fd2d6aaee811382fe48cf35519f559ee4f842 | T07 applicable runtime/control and real Terminal gates passed: r1 queue-stop + r2 cold reopen/new task; all historical FAIL/UNKNOWN retained. |
| #18 历史原文、trace、用量追查与固定证据 | integrated-accepted | #13, #16 | 3aecc37380a7c4678a3ce12b03740a6e2b52a332 | fe6757df3de554cd834b0f11b45167e59ed3b26c | T08 applicable acceptance passed: readonly query/trace/usage and verified content retention; actual failing shell/unknown usage demo plus installed readbacks. Historical FAIL retained; #17 native and #19/#27/#31 duties remain separate. |
| #19 自动与主动上下文压缩 | implementing | #18, #17 | — | — | Fresh implementer dispatched after #17/#18 applicable acceptance; public durable compaction with shared provider boundary from checked seam commits. |
| #20 保留保护下的归档、清理与一致性迁移 | integrated-accepted | #15, #18 | 68fb251623326b1a6357e7efb8b2602ecbc74f3e | 6d2d3aba847965542a3cab4e1653a2bc340bf92a | Applicable archive/retention/cleanup/migration evidence passed and merged product bytes bound; native management composition remains #31. |
| #21 固定计划下的受预算 eval 与独立评分 | integrated-accepted | #18, #12, #15 | a06e266c946e24c529b5bd344b98a1f0f6b61cb1 | c99360ff412b51c10041e6cea3a94d7b90213f8d | T11 applicable controlled-provider restricted runtime, budget, independent grading and installed readonly evidence accepted; paired comparison and paid model acceptance remain separate. |
| #22 fresh 对照与限定范围改善报告 | dispatching | #21 | — | — | Claimed after #21 accepted and integrated; fresh implementer dispatch in progress. |
| #23 improve 受限取证与候选报告 | ready | #17, #18 | — | — | NOT RUN |
| #24 improve 结构化选择、仅验证与建议抑制 | blocked-by-dependencies | #22, #23 | — | — | NOT RUN |
| #25 项目与配置候选的验证后写回、启用和回退 | blocked-by-dependencies | #24 | — | — | NOT RUN |
| #26 自身源码新构建与独立 eval 资产改进 | blocked-by-dependencies | #25 | — | — | NOT RUN |
| #27 任务验收三率与执行、验收双时钟 | ready | #17, #18 | — | — | NOT RUN |
| #28 全样本成本与任务、尝试故障报告 | blocked-by-dependencies | #27 | — | — | NOT RUN |
| #29 低打扰人工介入与交付后返工报告 | blocked-by-dependencies | #27 | — | — | NOT RUN |
| #30 真实 DeepSeek 代表任务与 improve 执行闭环 | blocked-by-dependencies | #25 | — | — | NOT RUN |
| #31 首版技术验收与轻量实测报告 | blocked-by-dependencies | #19, #28, #29, #26, #20, #30 | — | — | NOT RUN |
| #32 本机试用与明确日用接受 | blocked-by-dependencies | #31 | — | — | NOT RUN |

Provider paid authorization: NOT GRANTED
Human daily-use acceptance: NOT RUN
Final independent code review: NOT RUN

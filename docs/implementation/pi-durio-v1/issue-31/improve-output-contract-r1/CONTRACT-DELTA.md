# output-r1 完整报告与未选择候选的合同增量

产品仍为 `f26ae8f4b8039608a1fa796e1c69da4d8173d112`；本记录与[前一合同增量](../improve-only-repair-r2/CONTRACT-DELTA.md)及原62合同/22ACC/7MET索引合读。整体仍为 `PARTIAL_TECHNICAL_ACCEPTANCE_NOT_COMPLETE`，不改写任何原始报告、首败或旧执行身份。

| 合同 | 本轮新增事实 | 尚未完成或限制 |
| --- | --- | --- |
| I1, I2, I3 | 明确授权的一次真实分析完成，单JSON被宿主保存为complete report，生成1个有稳定ID/revision的项目候选；实时/重开/持久报告相同，selected为空，仅使用已登记项目源和受限取证工具。 | 原summary有自相矛盾，hypotheses[1]静态上错误；已披露且保留原文。schema完整不等于事实完全正确或效果获证。精确补丁未执行、未验证。 |
| S2, S4, E1, E2, E6, V6, V7, M2, M7, A2 | 4次物理请求均HTTP200，terminal usage/DONE完整，24585tokens全部known，cleanup confirmed、storage closed。累计45requests/130611known+1056768旧UNKNOWN=1187379charged tokens，保守估价USD1.4248548。 | remote termination仍unknown；非账户账单，不重复统计SDK镜像，不以raw952释放旧UNKNOWN。没有新性能、资源或不可变权重证明。 |
| I5, I8, I9, I10, A3 | 实际候选保持unselected/not-started/unverified。单文件改动与保护要求可供人类具体决定；没有调用候选API、执行验证、正式写回或激活。 | 后续须明确选择实际report/revision/baseline/plan，运行保护验证，记录正式写回/效果/重开；完整技术和用户本机日用接受仍未完成。 |

[真实读回](../../issue-30/improve-output-contract-r1/postrun-readback/REPORT.md) · [已知推理问题与精确补丁的静态说明](../../review/improve-output-contract-r1-candidate/STATIC-ANALYSIS.md)。完整身份见`contract-delta.json`。新分析授权已消费，不包含候选操作或另一次模型调用。#30仍待完整improve闭环，#31 PARTIAL，#32等待用户实际试用和明确接受。

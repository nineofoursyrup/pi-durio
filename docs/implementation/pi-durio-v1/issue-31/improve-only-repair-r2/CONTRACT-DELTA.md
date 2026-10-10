# improve r2 真实结果的合同补充

产品仍为 `f26ae8f4b8039608a1fa796e1c69da4d8173d112`。本记录补充 [前一合同增量](../provider-terminal-repair-r1/CONTRACT-DELTA.md)，与原 62 合同、22 ACC、7 MET 索引合读；整体仍为 `PARTIAL_TECHNICAL_ACCEPTANCE_NOT_COMPLETE`。

| 合同 | 本轮新增事实 | 限制 |
| --- | --- | --- |
| S2, S4, E1, E2, E6, V6, V7, I1 | 当前安装候选真实完成 7 次请求；每次 terminal usage / DONE 均完整，44,466 tokens 全部 known；runtime cleanup confirmed、storage closed。新增覆盖了已修复的真实结算路径。 | remote termination 按原记录仍为 unknown；旧 UNKNOWN 预留不释放；不证明不可变模型权重或 improve 成功。 |
| I2, I5, I8, I9, I10, A3 | 正式报告 incomplete / 0 candidates。严格 JSON 拒绝已复现；仅诊断抽取围栏后，原样 candidate validator 仍拒绝，原文另有事实错误。未选择、重建或执行候选。 | 有效真实报告、用户对实际候选的明确选择、保护检查、正式生效/写回与只读重开仍待完成。 |
| M2, M7, A2 | 累计 41 requests / 106,026 known tokens + 1,056,768 UNKNOWN reservation = 1,162,794 charged upper tokens，固定最高单价估算上界 USD 1.3953528。 | 非账户账单；SDK 镜像不重复相加；旧 raw 952 仅诊断；不增加新的时间/RSS 或轻量结论。 |

[真实批次读回](../../issue-30/improve-only-repair-r2/postrun-readback/REPORT.md) · [原文本诊断](../../issue-30/improve-only-repair-r2/postrun-readback/diagnostic-only/DIAGNOSIS.md)。完整来源身份见 `contract-delta.json`。其余合同行、旧首败与执行身份沿用原记录。本次一次启动已消费；后继分析批次尚无付费授权。#30 未完成，#31 PARTIAL，#32 等待用户实际试用与明确接受。

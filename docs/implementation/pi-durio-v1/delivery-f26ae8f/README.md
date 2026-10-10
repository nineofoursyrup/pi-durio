# 修复候选交付记录

固定产品候选 `f26ae8f4b8039608a1fa796e1c69da4d8173d112`，tree `ceebaeb3805dd8f2eeab948792f88e6f9a0ba2e0`。sourceBuild `8f4ce2a273559d871b76c1cf14971a0df048d7f86b8216ff45b3d8dd2a710821`；分发包 SHA256 `0be03d6d7e090f3ba58f55297f1c9dd50b28540fbba0ed76ae55d34419f1221b`。后续文档 tip 单独记录，旧9aed1af真实调用/native结果不改标。

LIVE-USD3-R3-01 已修复：完整raw SSE usage与DONE到达后，实际SDK正常关闭reader且cleanup成功时正确结算；真正中止、异常或不完整usage仍保持unknown。[独立Standards/Spec复核](../review/f26ae8f/review.md)均PASS，0硬问题，1非阻塞命名建议。最终boundary11/11、Pi runtime2/2、原始7块响应离线重放952→7均通过。旧组合250 PASS/1 FAIL与全部首败保留；旧未受影响检查按[适用gate](../review/f26ae8f/applicable-check-gate.json)复用，无新全套PASS声明。

新的源码archive与574个tracked文件逐字节对应，包及独立安装与构建内容一致。CLI help和12个公开入口导入PASS。旧依赖及Node/npm未变，[两项npm兼容性FAIL](../delivery-9aed1af/npm-diagnosis-REPORT.md)按相同内容复用，没有改标通过。新Linux runtime使用原依赖与新dist派生，完整字节/文件模式核对通过，未启动VM。

新包19,222,769bytes，完整安装90,158,076logical bytes；自有product80文件/7,531物理行。见[新体积实测](../issue-31/provider-terminal-repair-r1/MEASUREMENT.md)。旧时序/RSS/native测量仍只属于原候选，不声称新候选资源等价。独立[适用性报告](../review/f26ae8f/evidence-applicability.json)核对四类旧PASS的25次raw响应及3次native合成预算响应，允许在原范围复用未改行为；不增添人工IME、复制、小窗口或日用接受结论。

[当前22票状态](../status.md)记录 #11–#31 本票适用验收完成；[最终技术接受](../issue-31/TECHNICAL-ACCEPTANCE.md)及[独立两轴复审](../review/final-technical-f26ae8f/review.md)已完成。当前候选的真实 improve 经用户明确选择 R1 后，唯一执行完成 1 次保护回归/6 原用例 PASS、仅 clamp.ts 精确写回和只读重开一致，0 新 provider。[完整回读](../issue-30/improve-output-contract-r1/candidate-execution-plan-r1/postrun-readback/REPORT.md)保留全部身份；原模型推理错误、r2 输出契约失败、旧 UNKNOWN 和首败均未改写。

累计 45 次物理请求，保守占额 USD 1.4248548，非账户账单。#31 完整技术证据与当前必要测量已接受；[当前技术报告](../issue-31/final-f26ae8f/REPORT.md)列出准确口径。#32 用户在自己的 Mac 实际试用与明确接受仍未完成。此处的确定性修复成功不代表性能或模型质量改善。

全部Issue OPEN、PR Draft；main仍空仓bootstrap，没有产品main合并或release。原四个untracked、api.env ignore及旧dist完整保全；所需证据仍引用的worktree保留。大型清单和原始记录留在外部证据目录，`evidence-index.json`提供精确指纹。

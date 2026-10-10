# 修复候选交付记录

固定产品候选 `f26ae8f4b8039608a1fa796e1c69da4d8173d112`，tree `ceebaeb3805dd8f2eeab948792f88e6f9a0ba2e0`。sourceBuild `8f4ce2a273559d871b76c1cf14971a0df048d7f86b8216ff45b3d8dd2a710821`；分发包 SHA256 `0be03d6d7e090f3ba58f55297f1c9dd50b28540fbba0ed76ae55d34419f1221b`。后续文档 tip 单独记录，旧9aed1af真实调用/native结果不改标。

LIVE-USD3-R3-01 已修复：完整raw SSE usage与DONE到达后，实际SDK正常关闭reader且cleanup成功时正确结算；真正中止、异常或不完整usage仍保持unknown。[独立Standards/Spec复核](../review/f26ae8f/review.md)均PASS，0硬问题，1非阻塞命名建议。最终boundary11/11、Pi runtime2/2、原始7块响应离线重放952→7均通过。旧组合250 PASS/1 FAIL与全部首败保留；旧未受影响检查按[适用gate](../review/f26ae8f/applicable-check-gate.json)复用，无新全套PASS声明。

新的源码archive与574个tracked文件逐字节对应，包及独立安装与构建内容一致。CLI help和12个公开入口导入PASS。旧依赖及Node/npm未变，[两项npm兼容性FAIL](../delivery-9aed1af/npm-diagnosis-REPORT.md)按相同内容复用，没有改标通过。新Linux runtime使用原依赖与新dist派生，完整字节/文件模式核对通过，未启动VM。

新包19,222,769bytes，完整安装90,158,076logical bytes；自有product80文件/7,531物理行。见[新体积实测](../issue-31/provider-terminal-repair-r1/MEASUREMENT.md)。旧时序/RSS/native测量仍只属于原候选，不声称新候选资源等价。独立[适用性报告](../review/f26ae8f/evidence-applicability.json)核对四类旧PASS的25次raw响应及3次native合成预算响应，允许在原范围复用未改行为；不增添人工IME、复制、小窗口或日用接受结论。

[当前22票状态](../status.md)与[最新合同增量](../issue-31/improve-only-repair-r2/CONTRACT-DELTA.md)保留未完成项。当前候选的[真实 improve r2](../issue-30/improve-only-repair-r2/postrun-readback/REPORT.md)已完成7次请求、44466tokens全部known且cleanup confirmed，但正式report因模型输出契约失败incomplete / 0 candidates；旧UNKNOWN与首败保留，未证实新的产品解析缺陷。累计保守占额USD1.3953528，非账户账单。

[后继输入 revision](../issue-30/improve-output-contract-r1/README.md)保持同一产品和原fixture，仅明确输出合同，已完成[独立两轴复核](../review/improve-output-contract-r1/independent-review.md)。[新一次启动请求](../review/improve-output-contract-r1/authorization-request.md)尚未获准；新上限8请求/1200000tokens，累计估价上界USD2.8353528≤USD3。未来实际候选仍须人类选择；#30真实improve闭环、#31完整技术验收、#32用户本机试用与明确接受均未完成。

全部Issue OPEN、PR Draft；main仍空仓bootstrap，没有产品main合并或release。原四个untracked、api.env ignore及旧dist完整保全；所需证据仍引用的worktree保留。大型清单和原始记录留在外部证据目录，`evidence-index.json`提供精确指纹。

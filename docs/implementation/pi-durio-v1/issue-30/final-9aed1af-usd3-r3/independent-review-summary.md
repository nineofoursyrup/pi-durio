# 补充批次 r3 独立复核结果

准确 manifest `07ed36fdeb17f24d7e8d6caea0db4efd41dd31111fa7ef6ea4cb0a51daa0251e` 的独立 **Spec PASS / Standards PASS，0 硬问题、0 可选项**。两轴由同一位实现者之外的 reviewer 完成；本结论只覆盖冻结的补充 harness 与准备证据，不代表真实 #30 或整版验收。

[原 review JSON](independent-review.json) 逐字节保留；完整原始 Markdown 位于 `/Users/nineofour/pi-durio-v1-run/review/usd3/r3/review.md`，SHA256 `bb4b23fe023b3fa75d8dcf5286793d66c3eb860416e24ed0ec43d84e355d758d`。本摘要为仓库导航，不覆盖原报告。准备时的 README/checks 中 review pending 是原快照，由本结论补充。

复核了新旧授权区分、未授权前不读取凭据、不发真实请求、一次启动重放与并发排他、安装后的过期复核、host 累计预算及未知用量占额、共同期限、准确三例通过门、原 local-fix PASS 与首败身份、未变化的产品/案例/评分，以及真实 improve 候选仍须用户选择。

[只读身份校验](independent-identity-check.json) 涵盖23项直接绑定、原3167项、169构建输入、246编译输出、12925安装项和12851 Linux runtime文件/模式；这些不是行为测试计数。[文档校验](independent-documentation-check.json)确认 producer `fc9e2d4` 的31份副本一致。reviewer首次路径假设错误的[检查失败](reviewer-first-documentation-check-failure.json)保留，修正检查器后通过，执行源码未改。

35项新离线检查及12项仍适用的旧parser检查已复核，未重复跑产品build、全测试、provider或VM。完整只读身份大索引保留在上述review目录，原JSON记录其SHA256。

当前没有代码复核阻塞，但**尚未获得新的付费启动批准**。最新公开价目和模型上下文[复核](provider-prelaunch-observation.json)与冻结上界相符；这不证明账户实付或认证可用性。[启动申请](authorization-request.md)保留准确范围，未来实际候选另行选择。

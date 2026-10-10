# #30 补充批次启动申请

准备、35项新增离线检查及独立Spec/Standards复核均已完成。产品候选仍为 `9aed1af6ee3b156bb7354961496217aa5e64843e`；准确 manifest SHA256 为 **`07ed36fdeb17f24d7e8d6caea0db4efd41dd31111fa7ef6ea4cb0a51daa0251e`**，文件 `/Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af-usd3-r3/frozen-manifest.json`。

只补跑 multi-file、regression、no-change 各一次，三例均通过后做一次真实 improve 分析。原 local-fix PASS复用，原multi-file失败/UNKNOWN和not-run保留；不会把跨批次结果称为原单批4/4通过。产品8次限制、输入、fixture与grader不变。

新增最多32次请求/2,372,501 token；连同已用15次/27,499 token，累计最多47次/240万token。金额总帽仍USD3，按冻结最高价保守估算累计USD2.88。eval为24次/1,172,501 token，improve为8次/1,200,000 token；未知用量保留reservation，费用为估算而非账户实付。

新批准后24小时内仅启动一次，安装检查后实际start开始60分钟总期限。非PASS、认证、预算、未知用量、取消、超时或未确认清理即停止，不能自动再试。沿用用户已许可的 `/Users/nineofour/Durio/api.env`，不重新申请该来源许可。真实improve候选的revision、baseline、检查和写回范围将另行交给用户选择。

**为何需新批准：** 原冻结批次约定一次启动、失败即停，该次启动已消费。原USD3总帽和凭据许可持续有效，但不能代替新的这一次启动许可。

[完整冻结方案](README.md) · [独立复核](independent-review-summary.md) · [精确机器记录](independent-review.json)。准备时原README的review pending由上述完成复核记录补充。当前没有实际新grant/paid-start/authorized-plan；本文不构成用户授权。

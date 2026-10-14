---
status: accepted
---

# 完整原文保留与使用者主动缩减

2026-10-09，用户在 [#5 运行证据与长期记录合同](https://github.com/nineofoursyrup/pi-durio/issues/5) 的设计访谈中明确选择“保留所有原文，除非使用者主动压缩”，并确认清理由使用者主动发起。pi-durio 默认完整保留运行原文，不因期限、展示窗口或模型上下文限制自动丢弃；内存、显示和送模内容保持有界，不应以这些上限替代磁盘原文保留。

用户随后确认自动上下文压缩，并追加“用户可主动进行上下文压缩”。这两种上下文压缩只改变后续模型请求使用的上下文，保留原文、追加摘要并记录用量；它们都不构成删除磁盘历史的授权。

这项选择放弃默认只存必要片段或自动淘汰历史原文的路线，以保留事后追查及分析能力，接受更高的存储需求和使用者主动管理的成本。磁盘归档、清理保护未完成工作的恢复依赖及固定证据；具体落实见 [#5 设计合同](../design/runtime-evidence-and-retention.md)。本 ADR 不承诺取得服务端未返回的数据、掉电零丢失或每个历史任务完整可复现，也不表示实现已通过验证。

本 ADR 全文已随 [#5 resolution](https://github.com/nineofoursyrup/pi-durio/issues/5#issuecomment-6074633590)发布，票据已按用户明确授权关闭；远程收尾证据见[读回记录](../design/runtime-evidence-and-retention-readback.json)。

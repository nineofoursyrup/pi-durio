---
status: accepted
---

# 正式 eval 的独立执行与评分边界

2026-10-09，用户在 [#6](https://github.com/nineofoursyrup/pi-durio/issues/6) 对 Q1–Q3 回复“全按建议”，并强调尽可能极简。正式行为改善判定使用经过验证的受限 eval 环境，保护宿主、其他试次、评分规则和隐藏答案；普通 coding 仍采用 ADR-0001 的可信本机执行，二者共用产品 runtime。仅有 worktree 或独立 session 的本机试跑保留为诊断结果，不能代替正式改善证据，也不把受限环境结论自动外推到日常全权限执行。

这是用一项必要的 eval 执行边界换取评分可信度，放弃“仅靠目录分离、提示或 hash 就承诺独立评估”的路线。优先复用一种现成隔离能力，不自研通用沙箱、不建设完整实验平台；具体机制及边界须由实现验证。配套合同见 [Eval 与改善判定](../design/eval-and-improvement.md)，本 ADR 记录已确认取舍，不表示产品隔离已经实现。

本 ADR 全文已随 [#6 resolution](https://github.com/nineofoursyrup/pi-durio/issues/6#issuecomment-6075512766)发布，票据按用户明确授权关闭；[读回记录](../design/eval-and-improvement-readback.json)保存远程状态与正文核对。

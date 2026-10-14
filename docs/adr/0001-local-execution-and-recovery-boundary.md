---
status: accepted
---

# 可信本机执行与恢复核对

2026-10-09，用户在 [#3 上游复用与执行恢复边界](https://github.com/nineofoursyrup/pi-durio/issues/3) 的设计访谈中确认 Q1–Q3“全按建议”：首版普通 coding 采用可信本机执行，以减少沙箱实现与本机构建兼容的维护负担；这不承诺工具只能访问工作区，improve 分析仍须由宿主限制为证据读取能力。中断后有副作用的结果不确定时，先进行受限的只读恢复核对，可靠证据不足才交给用户决定；影响行为的执行版本发生变化时，不自动用新版本接管旧 pending，以可恢复性和行为可追溯为优先，接受必要时结束旧工作并开启新任务的成本。

备选是首版实现 OS 沙箱、让模型收到 interrupted 后自主重做，以及自动迁移跨执行版本的未完成工作；本轮没有选择这些路线。cwd、replay 标志和 prompt 都不能替代这些边界的落实。具体职责、普通默认值与验证条件见[设计文档](../design/upstream-execution-recovery.md)；[远程 resolution](https://github.com/nineofoursyrup/pi-durio/issues/3#issuecomment-6067523440)已发布并随票关闭。本 ADR 记录设计决策，不表示实现已经验证。

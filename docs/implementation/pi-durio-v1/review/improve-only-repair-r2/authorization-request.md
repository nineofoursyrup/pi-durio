# 一次真实 improve 分析的授权请求

产品候选：`f26ae8f4b8039608a1fa796e1c69da4d8173d112`。新批次 `pi-durio-v1-live-r3-improve-repair` 的 r2 manifest SHA256：`c1a3904f047ff3c19b16ba7c7e66dc57316f2ff9ad08a7080791ee5babe5fb2a`。

申请仅启动一次真实 DeepSeek `improve analysis`，使用原 clamp fixture、原 synthetic seed 和 r2 独立 dataRoot。新阶段最多 8 次物理请求、1,200,000 charged tokens；每请求预留最多 1,056,768 tokens，输出最多 8,192 tokens。

保留旧 34 次请求、61,560 known tokens 和 1,056,768 UNKNOWN 预留，不以诊断 raw952 回填或释放。新旧累计最多 42 次请求、2,318,328 charged tokens；按冻结最高列出单价 USD1.2/M 估算上界 **USD2.7819936**，仍受已批准的累计 **USD3** 上限约束。这是固定价目和保守 token 占额估算，未读取账户账单，也不声称平台已设置账单硬限额。

在本次直接人类回复后 24 小时内启动；活动截止为实际启动后 60 分钟，分析自身最多 5 分钟。凭据沿用已授权的 `/Users/nineofour/Durio/api.env`，只由实际启动 wrapper 读取，不进入模型或日志。新 unknown、失败、鉴权失败、取消、超时、超额或预算账本记录失败均停止；不自动补跑。

本次不运行 eval，不选择、执行、验证、启用或写回任何候选。若产生候选，会展示实际 report/revision、candidate、baseline 和保护范围，另行取得选择决定。保留所有旧 FAIL/UNKNOWN 与 r1 harness 首次评审失败。

建议回复：**批准 r2 一次 improve 分析，累计不超过 USD3。**

需要新回复的原因：原 r3 批次授权明确限制一次启动，已于上一批消费并停止；本次是修复后新冻结 manifest 的另一次启动。此边界来自你对具体批次的一次启动授权及原实施请求的付费授权要求，不是新增技能审批步骤。当前文件是请求文本，不是授权回执。

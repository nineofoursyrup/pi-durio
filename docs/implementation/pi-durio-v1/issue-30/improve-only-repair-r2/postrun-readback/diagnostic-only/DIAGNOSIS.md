# 真实 improve r2 输出诊断

本轮传输与 provider 结算修复得到真实覆盖：7 次 HTTP200，44,466 token 均 host known，cleanup confirmed、storage closed。正式报告仍为 incomplete / 0 candidates；本次一次启动已经消费，不自动补跑。

原始最终 answer 先输出英文说明，再输出 Markdown JSON 代码围栏。当前 `improve.ts:105` 直接解析一个 JSON 对象，复现原 SyntaxError。严格解析与失败保留符合现有合同，未证实解析器行为缺陷。

仅在只读诊断内提取唯一围栏，JSON 语法虽然有效，当前安装包的原样 pure candidate validator 仍拒绝：第二份草稿的 steps、validation.checks 为空，而且事实引用被 withheld 的 e1:24；该正文没有进入实际 acquired 集合。按原 journal 的 summary/derived 规则重建 used=11，数据库 hash 前后不变。不能通过去围栏就宣称报告已修复。

第一份草稿另有事实质量问题：它称原表达式在 [-9,-5,-1] 返回 -5、在 [6,0,10] 返回 6；原表达式直接求值分别为 -9 和 0。此处仅核对原表达式的两条陈述，没有执行候选或运行受保护 check。Schema 只能核验结构和引用，不能证明自然语言推理正确。两份草稿 activation.writeback/enable 均为 false。

所有提案仍只是未接受的模型原文，没有人工删除、改写或拼装成 canonical 候选。正式 revision `aaaa4af52f3e34ecb287d99b27d861da3baf3d5c21b1a48987b9cd12daf0fd90` 保持不变。没有产品、fixture、报告、journal、预算或 raw 响应变更。

后续可准备一个独立输入 revision，保持产品 f26ae8f、原 fixture、原 synthetic seed 与目标保护范围，仅把最终 JSON/候选字段/事实和 gaps 的区分写得明确；不向模型提供预期修复答案，不降低 validator，也不重写本轮结果。任何新的真实启动仍需新 manifest、预算核对、独立复核与直接人类授权。

复现命令：`python3 collect-inputs.py` 后执行 `node probe.mjs`。结果在 `probe-result.json`；首个辅助 collector 的 shape 假设错误也单独保留。此诊断没有 provider、VM、候选验证或写回。

Standards 结论：**FAIL**。3 项 documented breaches（P1 × 1、P2 × 2）；另有 1 项非阻塞 smell。

基线 `25d311616136766b37c0274f3f490ec1105f9592`；候选 `1be8e2826fa5d523e9224677838dd97b2d4d8ac3`；tree `e5ad9f25f84ded025fe7b2dff49fc08936a89eb3`。只读 checkout HEAD `ccc8e53257cb4274889b1a0bc3fd982fe6de3597`，开始与结束均 clean，tree 相同。请求模型 `gpt-6-astra/xhigh`；实际 backend 无法独立自证。

- **STD-01 / P1** — `src/preflight.ts:116,126–127` 全量解码所有 host facts，并累计每个历史 session 的完整 tasks/submissions/entries；`src/runtime.ts:477` 再写成一个 preflight record。历史增长使内存无界；总量超过 `src/evidence.ts:136` 的 2 MiB 上限后，正常新任务也不能启动。违反 ADR-0002:7 的“内存…保持有界”及 spec E2:69。应流式检查并保存有界摘要/引用。
- **STD-02 / P2** — `scripts/isolation/boundary.mjs:176`、`src/improve-process.ts:65` 将已由 data 事件收到、已追加到字符串的 stdout/stderr 截断；持久化只收到截断后的 result，没有完整原文附件。限额触发停止可以成立，但不能删除已取得尾部。这里是产品 eval/improve 检查、build 与新进程路径，非外部验收脚本。违反 ADR-0002:7、保留设计:147、spec E1:68；详见 appendix 的取得→截断→保存链。
- **STD-03 / P2** — `src/metrics/acceptance.ts:46`、`feedback.ts:19`、`costs.ts:17` 直接可写打开 Evidence；独立 CLI 也未取得或核对 data-root owner。短 SQLite 事务不覆盖产品 owner 生命周期，第二进程可在执行/归档持锁期间写入。违反 spec R2:49 与保留设计:144；同进程回调应复用经过验证的 owner，外部入口须先获取或拒绝。
- **SMELL-01 / optional judgement** — `src/derived-evidence.ts:26–28` 与 `src/improve-source.ts:13–15` 重复三套脱敏判定，例如 `if(/\u0000|�/.test(text))reasons.push(...)`。属于 possible Duplicated Code；可共享分类帮助函数，保留各自额外策略，不阻塞交付。

实际核对 diff/log、约定、相关实现和测试源码；#26 r6 的 156 个输入与候选一致，5 份检查日志 hash 匹配，限定结果复用。未运行 build、测试、VM、native 或 provider。#30/#31/#32 已声明门槛仍独立。详证在 `standards-review.json` 和 `standards-evidence/appendix.md`。

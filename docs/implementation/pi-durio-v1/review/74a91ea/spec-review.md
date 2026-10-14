# pi-durio v1 修复后独立 Spec review

结论：**PASS（本轮修复差异与相邻行为）**。新增硬缺陷 **0**，scope creep **0**。这不表示首版验收完成。

固定 candidate `74a91eac93c19e17e82a91a9ad38c3aaea023273`，tree `e3089debbbbc34a3a4ba48980087cf9bbd12589d`；修复基线 `1be8e2826fa5d523e9224677838dd97b2d4d8ac3`。HEAD/tree、tracked 工作区及 index 已核对。原规划未跟踪文件不在范围。请求 `gpt-6-astra/xhigh`；实际 backend 无独立证明。

- **SPEC-01 P1：已修复。** `spec.md:69` / `runtime-evidence-and-retention.md:41` 的内存有界要求已落实到 admission、目标 session 恢复及普通 close：逐页公共 Storage 读取、临时磁盘索引、有限报告和 usage 投影取代全历史数组/序列化。`recovery-projection.ts:26–142`、`recovery.ts:265–314` 仍扫描全部未知工具与 pending，末页未知、其他任务、stop intent、缺坏原文和过期 snapshot 不会被显示页截断绕过。原始内容及源文件 fencing 保留。复用 64 MiB 原文/48 MiB heap、旧 2 MiB close 接缝、分页决定与用量去重回归；不外推为日用 RSS 接受。
- **SPEC-02 P1：已修复。** `spec.md:51` / `eval-and-improvement.md:79` 的取消义务现在由 `scripts/live-batch/run.mjs:36–82` 接入：SIGINT/SIGTERM 保存首个意图、abort 共用控制器、等待阶段 API 清理后存结果；重复信号不跳过清理，取消后不放行下一阶段，unknown 保留。原入口 6/6 回归使用真实 OS 信号与离线 installed-API fixture，不能替代真实 provider/VM 验收。

输出修复的原始字节保留、固定依赖和失败语义，以及 metrics 的 owner 获取/借用/释放边界，未发现新的规格违反。未建立额外重构要求。旧报告、OOM 与信号首败均原样保留。

组合 **build PASS**；source/build 的 **554 项**、compiled tests/fixtures 的 **120 项** hash 读回无差异。**39 个测试文件、并发 2 的组合 gate 仍 IN_PROGRESS**；读回时尚无 `test-result.json`，没有宣称全套 PASS。阶段测试按原身份复用，不相加为最终总数。

仍待完成：**#30** 新冻结批次、明确付费授权/许可凭据来源、真实 coding/improve 闭环；**#31** 完整技术/资源与原生 Terminal 验收；**#32** 用户本机试用及明确日用接受。#16 已授权字宽接缝例外继续保留。本 reviewer 未运行新行为 probe、全套、VM、provider 或 Terminal，未修改产品/Git。

详细逐项来源与适用性见 [spec-review.json](/Users/nineofour/pi-durio-v1-run/review/74a91ea/spec-review.json)；独立身份读回见 [spec-evidence-readback.json](/Users/nineofour/pi-durio-v1-run/review/74a91ea/spec-evidence-readback.json)。规格路径均为 `/Users/nineofour/Durio/docs/specs/pi-durio-v1-spec.md`；其余合同在 `docs/design/`。

Spec：原 2 项 P1 已修复；新增 0，未结硬发现 0；外部验收 gate 未完成。

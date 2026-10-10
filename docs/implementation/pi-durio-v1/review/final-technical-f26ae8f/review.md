固定文档提交 `e748b12e2add451c8b05b8a6a0721bb92f5e636b` 的最终技术证据独立复核完成：**Standards PASS；Spec PASS；0 项阻塞，0 项新增可选建议。** 现有证据足以支持协调验收 #31，使 #11–#31 共 21 票完成技术范围，随后将 #32 交用户本机试用。日用接受、首版完成、main 合并、发布和 Issue 关闭仍未发生。

**固定范围与方法。** 文档 tree 为 `4c40ee45d26ca201878b4ef99d03de040e1f5067`，parent/docsBase 为 `780a4a072ffaf45dfcdf947607008f393cfae1a4`；产品仍为 `f26ae8f4b8039608a1fa796e1c69da4d8173d112` / tree `ceebaeb3805dd8f2eeab948792f88e6f9a0ba2e0` / sourceBuild `8f4ce2a273559d871b76c1cf14971a0df048d7f86b8216ff45b3d8dd2a710821`。增量仅 31 个新增文件、350,097 bytes，全部位于 `docs/implementation/pi-durio-v1/issue-31/final-f26ae8f/`；工作树内容与 commit 相同。对本轮有限文档证据变化，用同一独立 focused pass 分别审两轴；复用既有固定源码两轴评审及仍适用检查，不另做全量源码审查。

**Standards。** 已读取适用 AGENTS.md、domain/issue-tracker 约定、GLOSSARY、ADR-0001–0003 与 code-review skill 的全部 smell baseline。未发现标准硬违规或需新增的 smell 建议。候选、执行身份、测量方法、自动/人工观察和用户决定分开，冻结 harness 副本明确不是新入口。原 f26 源码 review 的 1 项 `frameBytes` 非阻塞命名建议仍保留在原范围，本轮不抹除或重复计数。

**Spec。** #31 六条均获适用支持：需求/工件索引、实现与真实链适用性、Terminal 行为、当前资源测量、去重成本、启动恢复及日用交接。91 行为 62 合同 + 22 ACC + 7 MET，全文/原行与历史权威索引一致，引用可取得、映射完整；这些是证据映射，不是 91 次独立测试。A2/A3/A4/ACC-22 的日用接受字段仍待用户。

独立读取 18 个 JSON、核对 126 个精确引用，大小与 SHA-256 全匹配。当前原生结果另从 samples、events、SQLite `mode=ro&immutable=1`、持久对象、机器事实和实际导出复算：14 次新进程启动正常退出；三次空闲均 ≥30 秒；60 轮 read/edit/check 各 20 次，至大输出为 309.829 秒；62 个 accepted/closed 的 run IDs 一致、124 次 synthetic / 0 real。64 个持久 tool.output 块重组为准确 1 MiB，五份完整导出同 hash；30 次查询、RSS 与采样间隔、42,099,297 bytes 数据根逻辑增长均与报告相符。3,092 个已读取原生相关文件前后 hash 不变。

N1 的原始 machine/source/queue/payload/frame 支持：旧 run 保留 aborted 原文并显式 ended，恢复报告保存；唯一新任务完成，旧 follow-up/compact 两项仍 frozen；结束操作可见后才输入，实际滚动 0 次；cleanup confirmed，raw/stty 恢复，六步退出 0、无漏跑或 TTY 修复。它是实际 Apple Terminal 的自动 native 集成观察，不是新人工 IME/复制/小窗口验收。旧人工观察只按明列场景复用：19 份原件 hash 相同，#16 r5/r6 的 12,635 条依赖与当前 manifest 完全相同，#17 r2 只差 esbuild 可执行文件，相关输入/复制模块与路径的适用性有具体比较；改变的恢复展示由当前 N1 补足。profile/字体 UNKNOWN 未改写。

成本复算为 eval 内 coding 33 请求/61,560 known tokens，improve 12 请求/69,051 known tokens，总计 45 请求、130,611 known + 1,056,768 保留 UNKNOWN，占额 1,187,379 tokens；固定历史最高单价下 USD 1.4248548 为保守估计，不是账单。guest/SDK/克隆记录不重复入账，事后 952 tokens 不释放旧 UNKNOWN。五个不重叠批次墙钟合计 326.247 秒，未冒充模型独占时间。真实 improve 的原错误、实际人类选择、6 例保护回归、111-byte clamp.ts 精确写回、三个保护文件及只读重开有独立记录；after 与保留 before 对象均已核对，不把授权写回误判为漂移，效果只为 direct-checks-passed。

**保留边界。** 旧组合 250 PASS / 1 FAIL、原模型/人工/native 首败、UNKNOWN 与旧候选实测身份均保留，没有新全套 PASS。npm 11.19.1 bundled `npm ls` 与 consumer 离线 `npm ci` 两项 FAIL 保持其安装路径限制；支持路径的安装/import 证据不被混写。进程冷启动未清系统缓存，firstFrame 不是像素呈现；RSS 仅宿主 Node 采样，增长不是泄漏或小时级稳定性结论；取得写入含分页/解码/close、未 fsync、无 tracing-off 对照。这些已披露范围不产生新的硬约束失败，也不构成“轻量通过”、模型质量或性能因果改善。

仅创建本 reviewer 目录内报告；没有导入/运行产品、重跑测试或测量、调用 provider/VM/Terminal、读取 api.env 内容、修改原素材/producer/root/shared state/GitHub。初次 reviewer 索引探针把旧 ACC 的字段误用为 `contract`；实际为 `original_row`，修正 schema 后 22 行逐项相同。初次结果与修正结果均保留，这是 reviewer 探针误报，不是产品故障；一次只读 SQL 探索的空结果亦在 readback 注明。

完整外部 readback 的精确路径、字节和 hash 见同目录 [review.json](review.json)；大型原始核算只留外部。请求模型/推理为 `gpt-6-astra / xhigh`，实际 backend 无独立可核验 attestation，记 **NOT_ATTESTED**。

Standards：0 hard + 0 new optional，无新增问题；Spec：0 findings，无已发现技术阻塞。#32 保持用户实际试用后的明确决定，不新增问卷、时长门槛或代答。

# #20 — 保留保护、归档、清理与一致性副本

实现入口是 `pi-durio/storage`，TUI `/storage` 独立面板，以及 headless `storage` 子命令。没有自动过期、容量淘汰或由 context compaction 调用清理的路径。管理不会打开 Harness、发出模型/工具请求，或授权恢复旧 pending。

## 实际管理范围

- `storage usage` 按 host facts、objects、sessions、未完成清理和其他保留文件列占用；session 列出关联项目。用 `--after N --limit N` 翻页。占用是只读即时观察；是否可删由持 owner 的 preview 核对。
- 无损归档明确选 `whole-root`：共享 host 事实、全部项目/session、对象、恢复决定和依赖一起保留；不会把整个根伪装成单 session。`attachments` 只包含显式指定的内容地址对象，并明确不是完整可执行根。
- 清理支持完整关闭的 session，以及有可核对引用的独立附件。session 的全部 conversation、task、submission 通过 Pi 1.1.0 公开 Storage 扫描；任一 pending、未知/未确认关闭、残留 owner、恢复决定、冻结请求或固定依赖阻断相关单元。所有宿主 record body、固定/解除固定决定和 manifest 永久保留。嵌在宿主事实正文里的原文不能独立清理，不能将它们当索引或逐条改 durable 消息。
- 后续 compaction/eval/improve 继续通过 `sources/dependencies` 固定实际内容；未完成 run 的显式 source 引用会保护所依赖的其他 run。缺坏 manifest 是错误，不是空保护集。固定保护关联 run 的 session 和实际 objects。

## 命令与确认边界

```sh
pi-durio storage usage --data-root ROOT
pi-durio storage preview --data-root ROOT --id cleanup-1 \
  --units session:SESSION,object:SHA256 --reason 'explicit scope'
pi-durio storage commit --data-root ROOT --id cleanup-1 --confirm PREVIEW_IDENTITY
pi-durio storage status --data-root ROOT --id cleanup-1

pi-durio storage archive --data-root ROOT --scope whole-root --destination NEW_ARCHIVE
pi-durio storage archive --data-root ROOT --scope attachments --objects SHA256 --destination NEW_ARCHIVE
pi-durio storage verify --archive ARCHIVE
pi-durio storage restore --archive ARCHIVE --destination NEW_ROOT
pi-durio storage migrate --data-root ROOT --backup NEW_ARCHIVE --destination NEW_ROOT

pi-durio storage unfix --data-root ROOT --id release-1 --evidence FIXED_EVIDENCE_ID --reason 'explicit release'
```

所有命令支持 `--format json|text`，两种格式序列化同一结果。preview 保存不可变计划、实际文件/hash/字节、引用及保护原因，不删除内容。commit 必须带同一 identity，并在当前 owner 下重新核对全剩余范围；新增保护、引用或内容漂移拒绝执行，不能扩大旧计划。用户可在预览中选择含被保护项的集合，提交仅作用于列出的 eligible 单元，protected 项始终排除。没有摘要替代原文的功能，预览明确删除的信息损失。

TUI 面板用方向键选择、`c` 预览、在实际渲染后的预览上 Enter 明确提交，`b` 返回、PgUp/PgDn 查看范围与结果。主历史面板仍只读。管理处理中独立面板拦截 Esc/Ctrl+O，避免误关后把输入发给任务；没有持有或改变当前 Harness/run/session 的能力。归档/还原和精确解除固定通过上述 CLI 明确给范围、目标和 ID。

## 清理中断与引用

管理事实继续追加到原 host evidence 库，不建另一套 trace/usage/保护账本。每项保存 intent；session 目录先整体移动到本根的 `management-trash/OP/SESSION`，逐文件删除后 fsync、保存结果。每项结果和 `evidence.availability` 一起提交。删除后但 receipt 前故障，重开依据原 intent 将缺失列为 `absent-after-recorded-intent`，不声称能证明外部副作用归属。部分失败停止后续项，以同一 operation ID/identity 显式继续；已完成项不重复执行。真实磁盘全满也可能无法写失败 receipt，原 intent 和阶段目录仍是核对依据。

删除 session 期间，新任务 admission 保持 blocked。只有完整 preview→明确 commit→owner 下全 Harness 检查→逐文件事实→最后 `management.session-removed` 和 part-result 匹配，preflight 才承认该已管理的缺失旧 session。缺 marker、缺文件结果、未完成操作或后来的控制/恢复事实继续阻断。此例外仅允许接受新工作，原 session 不能恢复。精确复制后的移除事实仍说明历史处置，但复制本身不授权执行。

旧任务结果、检查判断、身份和决定保持原值。独立附件的引用追加已清理状态；session 清理只把 durable session 标为不可取得，仍存在的 host 原文仍可读。最小删除事实只保存内容身份、范围、原因、时间和结果，不复制被删敏感正文。再次固定必须使用新的明确请求；同一旧 fixation ID 在解除后不会静默恢复保护。释放一项固定不解除其他固定对共享内容的保护。

## 一致性、格式与迁移

先持现有 data-root owner，拒绝 session owner 和未完成清理；在没有活动连接的 quiescent 根上采集完整文件集合与前后 hash，包括每个 durable 主库及 WAL。只在临时副本上使用 `openNodeSqliteStorage` 和公开扫描。压缩是逐文件流式 gzip；manifest 绑定相对路径、hash 和长度，解压限量并逐文件验证，实际还原后再核对 host 和全部 session 可读，成功才发布新目标。源文件不删除；清理须另 preview/commit。失败的 `.partial-*` 目录保留供核对；没有自动重试发布或覆盖现有目标。

当前受支持迁移是本 host 格式与 Pi 1.1.0 的同格式、可读验证后的新根副本。没有自建 schema 升级平台，也不改上游私有表。上游格式由公开 Storage 的迁移/读取机制在验证副本上处理；高版本/未知/损坏格式失败，原件及支持的 host 只读路径保留。迁移成功明确 `executionAuthorized:false`；原执行内容、授权、兼容性和 pending 仍由 #15/#17 检查。不会将当前进程切换到目标，也不会让旧源与目标同时继续同一 pending。

SQLite/Pi 的 WAL 和宿主 DELETE journal 分开处理。宿主未知 journal/schema 不尝试猜测迁移。`-shm` 是可重建锁缓存，不作为档案内容；WAL 是必须内容。管理不承诺掉电零丢失、任意外部写入者隔离、任意历史版本升级或损坏源的自动修复。

单次文件/事实最多 50,000、依赖边最多 200,000、清理选择最多 100 单元、计划最多 16 MiB；超过明确失败，不把截断结果当完整可清理范围。流式压缩/解压/哈希不将大附件整体装内存；事实正文逐条读取，只保留有界身份和依赖投影。

## 验证与交接

`test/storage.test.ts` 覆盖实际 Pi/SQLite fixture：固定/解除/共享保护、预览后漂移、完整 session 删除与 admission、冻结和另一 conversation 的待接入 write/summary、部分失败续作、无损归档与还原、非空 committed WAL 的迁移、未知格式/磁盘故障/owner 阻断、TUI 显示后才可提交与 CLI 回读。它不会归档或清理真实开发证据，所有数据由测试新建。

`node scripts/demo-storage.mjs NEW_OUTPUT [INSTALLED_PACKAGE_ROOT]` 在新目录中运行真实 Pi runtime + 明确 offline transport + 本机 shell；固定依赖阻挡、归档还原、精确删除与部分故障、未知格式及 WAL 迁移结果分别保存。失败的 shell 检查与 fixture assistant 的正常结束分开报告，不伪造任务验收。提供可选安装根用于验证独立安装包。

完整检查和首败、精确候选、实际演示与独立安装记录见同目录 validation/first-failures/handoff 文件以及 `/Users/nineofour/pi-durio-v1-run/evidence/issue-20`。未调用付费模型。普通面板组合的原生 Terminal 抽查保留给 #31；这里的合成 TUI 检查不冒充原生键码、宽度或输入法验收。未 push、关闭票、产品合并到 main 或 release。

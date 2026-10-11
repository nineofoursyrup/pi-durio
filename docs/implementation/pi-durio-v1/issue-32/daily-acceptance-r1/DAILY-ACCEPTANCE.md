# #32 日用接受与首版完成

用户在当前实现对话中明确回复：**“已试用当前版本，日用接受，收尾”**。固定产品候选 `f26ae8f4b8039608a1fa796e1c69da4d8173d112` 的必要技术证据仍适用，因此追加记录 **#32 完成、日用已接受、首版完成**；#11–#32 共 22 票实现与接受范围完成。

原话及候选绑定见 [user-response.json](user-response.json)，完整判定见 [acceptance.json](acceptance.json)。原话由协调在 `2026-10-11T11:14:32.716104+00:00` 记录；消息精确发送时间未暴露，该记录时间不冒充发送时间或试用时间。本次核对时间为 `2026-10-11T11:19:17.705778+00:00`。

这是一份后续接受记录。原 [TRIAL.md](../TRIAL.md)、[pending-acceptance.json](../pending-acceptance.json)、[准备检查](../documentation-checks.json)、[技术接受](../../issue-31/TECHNICAL-ACCEPTANCE.md)及既有评审保留生成时状态和原字节，不回写其中的历史 PENDING。

## 候选与技术证据适用性

文档基线为 `f346f77e8a9438aeeabb0a0dad67aaff7aa8bbbc`；本票分支从 `4cbebb8dc1f475945483f8b38eec48eab401327f` 仅 fast-forward 到该基线。产品 tree 为 `ceebaeb3805dd8f2eeab948792f88e6f9a0ba2e0`，`source-build.json` SHA-256 为 `8f4ce2a273559d871b76c1cf14971a0df048d7f86b8216ff45b3d8dd2a710821`。

从产品候选至文档基线，`src`、`test`、`scripts`、`vendor`、package/lock/tsconfig 均无变化。现有安装的 source-build、CLI 与 Node 文件大小和 SHA-256 均匹配原准备记录；两次试用辅助记录中保存的 source-build 与 CLI 也精确匹配。复用已接受的 #11–#31 技术证据和独立 Standards / Spec PASS，未重扫完整安装、未重跑全测、未新增 provider 请求或原生 Terminal 测试。引用与原件前后核对见 [applicable-readback.json](applicable-readback.json)。

## 实际使用与只读辅助记录

实际使用由用户原话直接确认。`/Users/nineofour/Library/Application Support/pi-durio-f26-user-trial-demo` 中有两次保存的 offline 运行，workspace 均为 `/Users/nineofour/Durio/test/fixtures/project`：

| run ID | 记录的执行开始 / 关闭时间（UTC） | 保存的结果 |
| --- | --- | --- |
| `86be33b0-b74a-48ac-b3b7-94f00aeedca6` | `2026-10-10T11:51:22.099Z` / `2026-10-10T11:51:22.579Z` | completed；observation ok；cleanup confirmed |
| `6141c3c6-84f1-4010-ad28-cdff115e3fc2` | `2026-10-10T11:52:52.480Z` / `2026-10-10T11:52:52.715Z` | completed；observation ok；cleanup confirmed |

保存的执行工件确认 `darwin / arm64 / Node v26.8.2`。原准备记录的机器为 macOS `27.2 (26B5101f)`、`MacBookPro18,1`、32 GiB RAM，已安装 Apple Terminal `2.15 / 488.7`；这些仍标明为准备时机器事实。实际 Terminal 应用、profile、字体、窗口尺寸未在本轮只读记录中独立取得，保持 UNKNOWN。上表是产品执行事件时间，不是用户开始/结束试用时间；完整人工试用时长 UNKNOWN。

保存的运行 `mode=offline`、`source=synthetic`。原试用入口使用固定响应的 `demoTransport`，无真实模型推理；记录里的 DeepSeek 配置名、URL 和 `model.dispatch` 不作为物理 provider 请求证据。上述结果只辅助核对当前候选的离线使用，不扩大既有真实 coding / improve 技术结论。推荐的真实任务数据根 `pi-durio-f26-user-trial` 在核对时不存在，其他真实任务活动 UNKNOWN；不据此猜测用户未记录的任务。

读取前确认各 SQLite 文件无 WAL/SHM；先查看 schema，再以 `mode=ro&immutable=1` 查询 `host.sqlite` 的必要字段。数据库和所选对象的大小/摘要核对通过，原件前后不变。未调用产品、Harness、恢复、TUI、VM 或 provider；未读取凭据，未导出用户 prompt、回答原文或无关 payload。

## 接受范围与保留限制

用户实际试用及明确日用接受与适用的完整技术证据同时成立，满足 #32 和规格 A2/A3。没有增加问卷、最低时长、重复付费或字体/profile 补录门槛；本次没有先修正反馈。

原有首败、FAIL、UNKNOWN、NOT RUN、npm `11.19.1` 下 bundled `file:` 依赖的 `npm ls` invalid / 消费端离线 `npm ci` FAIL，以及历史 IME、emoji、复制、小窗口观察的限定复用均保留。日用接受不重写这些事实，也不证明小时级稳定性或一般模型质量。

此提交只追加 #32 记录；协调负责后续集成和已授权的分支 / Draft PR 收尾。Issue 在核对时仍 OPEN；本记录不关闭 Issue，不修改父规格 #10 / Map #1，不授权新的付费批次、产品合并到 main 或发布。请求模型 / 推理为 `gpt-6-astra / xhigh`，实际 backend 为 **NOT_ATTESTED**。

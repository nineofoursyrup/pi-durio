# 固定产品候选的交付记录

产品候选 `9aed1af6ee3b156bb7354961496217aa5e64843e`，tree `d76896b400bb90c3beb82d847d9b43ba86fc5a07`。sourceBuild SHA256 `0559e34005b6b6f981af0b09877f4a8c4d7bcb15dc05e9ce21435370145d6886`；固定分发包 SHA256 `3628f9fd3e6c66cf7cd123dd9ea3dc6260c3be07ffb556d0972197e221d66d9a`。文档回写 tip 另外通过 Git/PR 读回，不覆盖上述实际执行身份。

适用独立评审和检查已完成；全产品技术及日用验收仍未完成。[22 票状态](../status.md)与[合同逐项索引 r2](../issue-31/final-9aed1af/contract-evidence-index-r2.json)记录完成范围及缺口，原索引和首失败仍保留。

## 检查与修复

旧候选 `74a91ea` 的组合结果为 251 tests / 250 PASS / 1 FAIL / 0 skipped，原首败保持不变。当前修复了期限不足仍启动 VM、停止原因被缺失导出覆盖的问题；源 fixture 的 600000ms 是新预声明输入，原 300000ms 失败未改写。7 个边界负例先 RED 后 GREEN；10 个 controller 调用链负例验证取消/期限边界；真实 smoke、source/build、输出保留和离线 eval 共 11 VM，均确认清理。controller 和合成请求不被当成隔离或真实模型证据。

当前 source/compiler/output 共 555 项，加 123 个 compiled tests/fixtures 的内容身份已由 merger 及独立 reviewer 读回。未改检查按明确适用性复用，不在交付时重复 build、全测试或所有 VM。Spec 和 Standards 的新增硬问题均为 0；可选 smell 单列，未额外扩大修复范围。

## 安装和工具限制

固定 archive 与 398 个 tracked 源文件对应；包、编译输出和独立安装内容一致。全新空 cache 的首次/重复离线 npm install、CLI help 及全部 12 public imports 均通过。原 `result.json` 保留 `CONTENT_VERIFIED_WITH_DEPENDENCY_REPORT_FAILURE`；后续归因在 `dependency-report-disposition.json`，未覆盖成 PASS。

npm 11.19.1 两项失败独立保留：bundled `file:` 来源元数据使 `npm ls` 报 invalid；消费端自动生成的 lock 缺少 25 个非本机 optional 平台节点，使离线 consumer npm ci 失败。最小复现、源码根因及可操作安装路径见 `npm-diagnosis-REPORT.md`。它们不推翻源码仓库完整 lock 的原 npm ci 证据，也不被概括为所有 npm 版本或在线路径的结论。没有为消除工具告警修改原锁、改 npm、替换授权 pi-tui 或增加平台范围。

## 当前可用本地测量

[测量报告](../issue-31/final-9aed1af/partial-report.md)记录 14 次启动、五分钟 60 轮连续任务、1 MiB 完整输出和后续普通任务、30 次只读查询及 5 次完整导出。完整 retained 数据 inventory 未变。RSS 为宿主按计划 1Hz 采样，实际最长间隔约 3.85s，包含同步工作和调度延迟；完整说明见[采样间隔记录](../issue-31/final-9aed1af/sampling-gaps.json)。没有数值验收阈值、隔离 tracing 开销或数小时稳定性结论。

安装包含 97 个在完整源 lock 中识别的包，没有标记 dev 的安装项；@types/node 仍作为传递依赖存在，TypeScript 和 @types/proper-lockfile 未安装。Node 自身不计入包体积；native 文件、重复依赖、逻辑/allocated bytes 和外部验收 helper 单列，详见测量 JSON。

## 未完成和保全

- #30：获授权的 USD 3 批次已启动一次并按失败条件停止；15 次真实 HTTP 请求、27,499 token，按固定最高单价估算 USD 0.0329988（未查账户账单）。local-fix PASS，multi-file 达到单任务 8 次请求限制后未完成，其余两例及真实 improve 未运行。原批次不可自动重复，实际 improve 候选生成后仍需具体选择。
- #31：最终原生 Terminal 的三个 idle、60+2 任务、组合流程、30 次查询和 5 次导出已有适用证据；首批 harness 轮询失败与后续定向补测分别保留，见[原生结果](../issue-31/final-9aed1af/native-followup-r1-report.md)。整体因真实 #30 未完成仍为 PARTIAL。
- #32：只能由用户在自己的 Mac 实际试用并明确接受；当前 NOT RUN。
- 全部 Issue OPEN，Draft PR 保持 Draft，main 仅原空仓 bootstrap；没有产品 main merge 或 release。
- 早期 29 个本轮临时 worktree 的已集成、tracked clean 状态保留在原 `worktree-preservation-audit.json`；后续证据 worktree 的身份由各次 merge receipt 单独记录。它们仍可能被 immutable producer/compiled/evidence 路径引用，本次保留，未删除原始证据、未集成或无关材料。

完整原始日志、安装 inventory、manifest、VM outcome 和失败记录保留在 `/Users/nineofour/pi-durio-v1-run/`；仓库内是可审阅报告、必要小型记录和精确 hash 指针。没有把这些部分完成状态宣称为首版 ready for review、日用接受或发布。

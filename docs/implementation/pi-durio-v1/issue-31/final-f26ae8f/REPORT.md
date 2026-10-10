# 当前候选技术验收报告（技术证据已齐）

当前产品候选为 `f26ae8f4b8039608a1fa796e1c69da4d8173d112`，tree `ceebaeb3805dd8f2eeab948792f88e6f9a0ba2e0`，source/build SHA-256 `8f4ce2a273559d871b76c1cf14971a0df048d7f86b8216ff45b3d8dd2a710821`。本报告的文档基线为 `780a4a072ffaf45dfcdf947607008f393cfae1a4`。**#31 当前技术证据已齐，待独立审查及协调验收；#32 日用接受仍待用户；Issues OPEN、PR Draft。**

[91 行合同索引](contract-evidence-index.md)及其 [JSON](contract-evidence-index.json)包含 62 条完整合同、22 ACC、7 MET 的当前身份、证据引用与状态。91 行均有适用范围内证据支持；这些计数包含映射行，不能视为 91 个独立测试或日用接受。历史完整索引保留每票原测试、全文合同、首败与原状态，当前索引通过固定文件身份和行 ID 指向它。

## 验收标准与剩余条件

| #31 条件 | 当前结论 |
| --- | --- |
| AC1 完整需求到证据索引 | 当前 91 行索引已整理，当前 M2–M4/N1 均取得适用结果 |
| AC2 实现、构建、审查与真实链 | #11–30 本票适用验收完成；当前独立源码 review/受影响检查及限定复用见索引。真实 coding 四类和 improve 完整链有证据；历史失败保留 |
| AC3 原生 Terminal 操作 | 人工 IME、emoji、复制、小网格等只能按代码/依赖/环境范围复用；当前冷恢复 N1 在真实 Apple Terminal PASS |
| AC4 体积、启动、RSS、长会话与数据增长 | 当前体积与 M1 已实测；当前原生空闲 M2、60 轮加大输出 M3、只读查询与取得输出写入 M4 已测 |
| AC5 分项成本与完整报告 | 已去重已有真实批次 token/请求/时长并保留 UNKNOWN；当前完整原文增长及查询/取得写入时长已测，见原生报告 |
| AC6 技术结论与日用交接 | 启动/配置/恢复说明已准备；当前技术证据待独立审查及协调接受，不给日用接受结论 |

## 当前实际测量

环境为 macOS `27.2 (26B5101f)`、`arm64 / MacBookPro18,1`、32 GiB RAM、Node `v26.8.2`。已安装 Apple Terminal `2.15 / 488.7`；实际 Terminal profile、字体为 `UNKNOWN`，当前实测尺寸 120×30。准备及原生批次预检核对当前完整安装 14,230 条内容清单及候选身份；实际 Terminal 操作另见原生报告。

| 项目 | 当前候选实测 |
| --- | ---: |
| 自有产品源码 | 80 文件 / 795,472 bytes / 7,531 物理行 |
| 测试 | 42 文件 / 486,214 bytes / 4,640 物理行 |
| 项目 scripts | 39 文件 / 286,749 bytes / 2,557 物理行 |
| 本轮外部测量 JavaScript helpers | 6 文件 / 47,044 bytes / 403 物理行；单列，不计入产品源码 |
| 压缩分发包 | 19,222,769 bytes |
| 完整独立安装 | 90,158,076 logical bytes |
| M1 `help` | 7 次；min / median / max = 208.572 / 212.937 / 229.042 ms |
| M1 空数据历史查询 | 7 次；min / median / max = 204.740 / 207.690 / 214.063 ms |
| M1 退出 | 14/14 exit 0；空数据响应明确 `missing`，不是历史不存在证明 |
| M2 原生空闲 RSS | 3 次各 ≥30 秒；详见原生报告 |
| M3 原生长会话 / 输出 / RSS / 完整原文增长 | 60+2 任务；RSS 中位 280.859 MiB、采样峰值 289.656 MiB；原文增长 42,099,297 bytes |
| M4 只读查询 / 输出取得写入 | 30 次查询 / 5 次完整 1 MiB 导出；源内容未变 |
| N1 原生冷恢复与退出 | PASS，原队列 frozen、仅全新任务接入、TTY 恢复 |

M1 于 `2026-10-10T10:59:19.602023Z` 至 `10:59:22.639012Z` 执行；逐次原始结果见 [startup-result.json](startup-result.json)。进程每次新建，未清系统缓存，不等同系统冷启动。文件行数含空行和注释，安装包含依赖/vendor，不含外部 Node；没有预设体积或时间阈值，不能据此声称“轻量通过”。旧 `9aed1af` 的 RSS 和计时仍是旧候选实测，未写成当前数值。

## 已有真实效果与成本

首批 local-fix PASS、multi-file execution_error/grade UNKNOWN、两例 NOT RUN 的事实保留；补充批次 multi-file/regression/no-change 分别 PASS。四类 PASS 由不同固定批次组合得到，当前适用性有独立审查，不宣称首批四例全过或新候选重跑。

真实 improve 分析的旧失败、UNKNOWN、canonical report 中的推理错误完整保留。用户直接选择 R1 后，冻结计划只执行一次：`2026-10-10T10:45:25.690Z → 10:45:29.192Z`，exit 0；真实受限回归 6 个原例 PASS、VM terminated、仅 `clamp.ts` 111 bytes 写回、三项保护文件不变、只读重开一致。效果为 `direct-checks-passed`，不证明模型能力或性能提升。[完整回读](../../issue-30/improve-output-contract-r1/candidate-execution-plan-r1/postrun-readback/REPORT.md)。

| 活动 | 物理请求 | 已知 tokens | UNKNOWN 预留 |
| --- | ---: | ---: | ---: |
| 独立普通 coding | 无独立付费样本 | 不重复计入 eval guest 镜像 | — |
| 正式 eval 内的真实 coding／工具任务 | 33 | 61,560 | 0 |
| improve（含旧失败和两次修复分析） | 12 | 69,051 | 1,056,768 |
| 独立 maintenance | 0 次已派发模型请求 | 不推定完成免费模型维护任务 | — |
| 合计 | 45 | 130,611 | 1,056,768 |

保留的 charged upper 为 `1,187,379 tokens`；沿用冻结的最高单价 USD 1.2/M 估算，上界 `USD 1.4248548`、仅已知部分 `USD 0.1567332`，均非账户账单。旧 improve 原文事后观察到的 952 tokens 只用于诊断，不释放或改写 UNKNOWN，不和 host/SDK/guest 镜像相加。逐批时间区间、分项与证据 hash 见 [accounting-readback.json](accounting-readback.json)；没有足够跨度记录分离网络、模型与本地耗时。

| 实际批次 | 整批墙钟秒 |
| --- | ---: |
| 首批正式 eval（含保留失败） | 67.967 |
| 补充 eval + 首次 improve 失败 | 169.075 |
| improve 机制修复分析 | 49.887 |
| improve 输出契约分析 | 35.816 |
| 用户 R1 选择后的受限回归与写回 | 3.502 |

以上不重叠批次区间合计 326.247s，包含本地准备、模型/网络与检查；不含批间等待、人工审阅，不是模型独占时间或项目交付周期。本轮测量 helper 的完整分项见 [measurement-harness-inventory.json](measurement-harness-inventory.json)。

## 原生证据与运行准备

[适用性核对](reconciliation-preparation.md)比较了旧人工候选与当前实际模块、方法、完整依赖清单和 19 份原始人工记录；#16 r5/r6 的 12,635 条依赖均相同，#17 r2 仅 esbuild 可执行文件不同，pi-tui 相同。复用结论只覆盖所列输入/复制/布局/退出路径；不把自动注入当新人工 IME、复制或日用观察。当前恢复文本/分页存在变化，本轮 N1 已提供当前原生证据。

已冻结 `preparation-r2/run-native.command`，要求用户在实际 Apple Terminal、至少 80×24、保持尺寸运行。它只做 M2–M4/N1：3 次 30 秒空闲、至少五分钟的 60 轮 read/edit/check、1 MiB 输出及下一普通任务、30 次查询/5 次导出、一次冷恢复；合成 transport，0 provider、0 VM。原工具拒绝操作 Apple Terminal 的记录见 [native-tool-refusal.json](native-tool-refusal.json)，未通过其他 UI 路径绕开。用户实际启动后六步均正常退出、TTY 一致；完整原始结果与范围见 [NATIVE-REPORT.md](NATIVE-REPORT.md)。没有重启或重复批次。

准备期 initial→r1 仅增加捕获 runtime error / cleanup 检查，r1→r2 增加看到结束操作前的有界滚动；最初及后续 freeze 内容和 diff 均保留，见 [preparation-history.json](preparation-history.json)。文档附带的两个新 harness 是冻结内容副本；其他未变脚本及完整 manifest 保留在引用的外部目录。文档副本不是新的运行入口。

## 已知限制与交付边界

- npm `11.19.1` bundled `file:` 的 `npm ls` invalid 和消费端 offline `npm ci` FAIL 继续保留；首次/重复离线 `npm install` 与源码完整锁的 `npm ci` 有不同的适用证据，详见[安装诊断](../../delivery-9aed1af/npm-diagnosis-REPORT.md)。
- 模型 alias、HTTP 返回身份和 fingerprint 不证明 immutable model weights。本票编写 agent 的 requested model/reasoning 为 `gpt-6-astra/xhigh`，实际 backend 未获可核验证明，记 `NOT_ATTESTED`。
- 当前测量只采样宿主 Node RSS；无阈值、未覆盖小时级稳定性。原文默认不删除，未加密；中止不撤回已有文件变化或费用，远端终止未知时保留 UNKNOWN。
- 本目录只补文档和证据，没有新产品源码、全量测试、付费请求或 VM；用户启动的一次真实 Terminal 合成工作负载已完成。日用接受、main 合并、发布和 Issue 关闭均未发生。

[启动、配置和恢复说明](STARTUP-RECOVERY.md)。当前技术证据状态为 `TECHNICAL_EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW`；协调验收后才能进入 #32 的实际日用接受。

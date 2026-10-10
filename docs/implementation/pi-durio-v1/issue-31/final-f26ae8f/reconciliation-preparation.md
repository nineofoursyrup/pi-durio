# #31 当前候选最小 gap 审计与准备

状态：**PARTIAL_TECHNICAL_ACCEPTANCE_NOT_COMPLETE**。固定产品候选 `f26ae8f4b8039608a1fa796e1c69da4d8173d112`，tree `ceebaeb3805dd8f2eeab948792f88e6f9a0ba2e0`，sourceBuild `8f4ce2a273559d871b76c1cf14971a0df048d7f86b8216ff45b3d8dd2a710821`。本工作树从 `a1f448589cc0900380bf971b21477408eaa32f2b` clean fast-forward 到 docs tip `fc6a62dc3de5726a845ffdeb61b5bd5543cd51d1`。本轮仅静态读取/解析/哈希；没有 import 产品 API、provider、VM、Terminal 操作或测量负载，也没有修改 root/shared state/旧证据。Agent 模型请求 `gpt-6-astra / xhigh`，实际 backend **NOT_ATTESTED**。

## 六条验收标准

| #31 条件 | 已有适用证据 | 真正剩余工作 |
| --- | --- | --- |
| 1. 完整候选和合同索引 | 当前源码 archive、package/lock、build、独立安装、配置、旧 dirty 输入、fixtures/grader、原文可取得；历史索引覆盖 62 合同 / 22 ACC / 7 MET | 将当前候选及最新证据逐条对齐，保留旧行/旧 gate，新增当前 state；这是文档/只读核对工作。已授权写回后的 clamp 必须与原 before baseline 分开索引，不能将合法 after 判为破坏旧证据。 |
| 2. 公共入口、运行/恢复/授权/原文/隔离/eval/improve/指标/provider 适用性 | 当前安装 help + 12 公开入口通过；最终 affected gate 和独立两轴 review 通过；4 类真实 coding 有独立有界复用；#30 新的真实选择、受限回归、精确写回、只读重开均有原件 | 等 #30 纯证据提交合入并将其引用对齐。没有再次 paid / VM / 全量确定性重跑的理由。npm 两项兼容性 FAIL 继续作为指定失败安装路径限制，成功支持路径另列。 |
| 3. 最终原生 Terminal | #16 r5/r6 人工 IME/字符簇/复制/最小尺寸原件存在；#17 人工队列/中止/恢复原件存在；旧最终 native long/composition/readonly 有独立 f26 行为适用性结论 | 核对结果支持核心人工观察有界复用，不需全套人工重做。后续恢复检查/分页及呈现有实际改动，缺当前原生冷恢复的组合观察；仅补一项 cold reopen → 显式结束 → 新任务 → 旧队列冻结 → TTY 恢复。它是原生集成补项，不将自动按键当成人工 IME/复制。 |
| 4. 本机轻量实测 | f26 的源码、测试、scripts、vendor、依赖、包/安装体积已同口径实测，含 Node 排除及逻辑/APFS 范围 | **必须实际补测**当前候选 process-cold 启动、native idle/代表长会话 RSS、原文记录增长、大输出、查询/获取写盘时序。旧 9aed 数值仅为历史，不能靠 parser 变化很小推定相等。 |
| 5. 工作分类用量、时间、费用/unknown | #30 已有实际 requests/known/UNKNOWN 占额；分析结束及选择执行时间；维护/本地测量可按既有记录归类 | 汇总并去重 coding/eval/improve/独立维护，单列完整原文磁盘增长；未采到网络/模型与本地分解时明确不可分离。依赖条件 4 的新本地测量，**不缺新的 paid run**。未执行独立维护模型工作记未执行，不能写成“实测免费”。 |
| 6. 完整报告和启动恢复交付 | 有安装和启动/配置/恢复/限制文档基线 | 完成 1/3/4/5 后才能标技术完成并提供 #32 日用试用；此刻不能宣布 #31 完成。 |

## 人工观察为何能有界复用

`reconciliation-preparation.json` 保存每候选源码/compiled/依赖清单对比、函数文本 hash、原环境和 19 份原件 hash 回核，全部所选原件一致。

- #16 r5/r6 对当前安装的 **12,635 个 dependency 条目（含 4 symlink）全部相同**。#17 r2 只有 `node_modules/esbuild/bin/esbuild` 这一个条目不同；不得声称全部依赖相同。`pi-tui` 依赖内容仍一致，所涉 TUI 直接执行路径不通过这个构建工具入口。
- `cursor.js`、`drafts.js`、`width-probe.js` 字节始终相同；当前 `width-gate.js` 等于 #17 r2。#16→#17 新增 recovery 查询 hold，已由 #17 实际冷启动观察覆盖，未变 IME/字宽测量算法。
- 当前 `ReadOnlyTui` 的 `constructor/start/input/stop/exit/finishExit/copyOutput/finished/recoveryDecision/queueDecision/loadQueue/rebuild/bottom/closePanel` 方法文本等于 #17 r2。相同的 Editor、MouseRegion、clipboard callback 和 minimum-grid 布局，加原人工观察，支持复用输入/鼠标复制/40×12 核心结论。#16→#17 的变化已逐段读过，不能把整个 app 文件写成未变。
- `openPanel/panelInput` 新增 improve/eval/metrics/compaction 分支；既有基本复制/输入/操作菜单的路径保留。后续 improve TUI 的实际 native 自动流程以及 #30 的直接人类候选选择共同覆盖各自边界，不要求为同一真实模型任务在每个入口重复付费。
- `openRecovery/recoveryText` 和底层 recovery/runtime 后续改了 bounded inspection 与分页；新的组合目前只有确定性证据。不能把 #17 旧人验泛化成后续恢复页在本机 Terminal 已测，故单列 N1。

原环境为 macOS 27.2 arm64、Node v26.8.2、Apple_Terminal 488.7，早期原件 locale 为 `zh_CN.UTF-8`。旧记录未取得 Terminal profile/font 身份，继续标未知，不杜撰。下一次 freeze 应记录实际环境；若相关条件变化再调整复用范围。OS 窗口切换焦点附加探查仍 UNKNOWN。`👩‍💻` 实际为 5 格的观察保留，不承诺改变 Terminal 原生字形。

## 最小实际补测计划（尚未启动或冻结新执行配置）

在协调安排的独占窗口，复用现有外部 harness，仅换成当前固定独立安装及全新输出目录：

1. **M1**：`process-startup.mjs`，7 次 help + 7 次空数据只读查询。进程冷启动，非清系统缓存后的机器冷启动。
2. **M2**：`native-idle.mjs`，3 次真实 Apple Terminal 首帧与 30 秒空闲，1 秒 RSS 采样；首帧发射与像素呈现时延区分。
3. **M3**：`native-session.mjs`，同口径 60 轮 read/edit/check，至少 5 分钟；每十轮 history/回当前，追加 1 MiB 原文输出和下一正常任务。一次负载同时提供当前长会话 RSS、时序、存储分阶段增长、大输出与后续输入；不重复 headless 60 轮。
4. **M4**：`readonly-data.mjs`，对 M3 完成数据做 30 次有界查询及 5 次完整获取写入新导出目录，逐份 hash，源 inventory 前后一致。不是孤立磁盘延迟或 fsync 保证。
5. **N1**：以现有 `scripts/recovery-start-terminal-validation.mjs` 场景为基础，给当前安装新建独立停止/冻结队列夹具，原生 cold reopen 一次，观察只读恢复页、明确结束、执行一个新任务、原队列仍冻结，退出 raw/stty 恢复。可保留原 runner 的人工 P/FAIL 输入；若改为真实 Terminal 自动操作，只申明其可观察的集成事实，不代替人类感知结论。无需重新 human IME/复制全套。

没有新的 provider、VM 或 improve fixture 写回需求；本计划不重复旧 composition 的 VM 回归，不触碰 #30 正式 fixture。每步失败即保留首败并停止相关负载，不将不足轮数写成完成。freeze/候选身份检查、实际 Terminal 环境、完整重复原值、系统负载与退出结果在运行前后保存。

## #30 新事实与不能更改的历史

只读核对 `candidate-execution-plan-r1/execution-result.json`、`reopened-decision.json`、`formal-file-readback.json` 及新 postrun report：`COMPLETED_EXACT_PROJECT_WRITEBACK`，1 次实际受限检查，0 新 provider，`clamp.ts` 精确 111 bytes/after SHA `45e016afe980df19159fc0679a6e44d88838a7a5afc398820309b576884f003c`，另外三个保护文件均与 readback 相同。此 after 是用户 R1 明确授权的结果；原 canonical reasoning error、原 before 清单及失败记录不改。

累计 45 物理 requests、130,611 known tokens、1,056,768 旧 UNKNOWN reserved tokens、1,187,379 charged upper tokens、USD 1.4248548 保守估价；不是账单。效果为 `direct-checks-passed`，不推导模型质量/性能收益。#30 实现者的 postrun SHA `52eea9ebdbdae1f25a7cf1811f4ca53144b962bd9c82299c1bcbe5c07351e3fb` 已回核。#30 证据合入由协调处理。

npm 11.19.1 的 bundled-file `npm ls` 和 consumer offline `npm ci` 保留 FAIL；原 native 首败 `IMPROVE_REPORT_NOT_FOUND`、#16 人工 F/U、#17 WIDTH_CPR_TIMEOUT 等均保留。所有 Issue 仍 OPEN、PR Draft、没有 main 产品合并或 release。

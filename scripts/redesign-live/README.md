# #93：三条真实模型路径的准备包

状态为 **PREP**。本目录只提供离线校验、冻结、人工操作卡和证据索引；没有 `run` 或 `launch` 命令。全部入口都不读取凭据或环境中的 key、不导入产品、不启动子进程/Terminal.app/VM、不访问模型。模板不授权付费、未知候选或真实验收。`PREP_VALID` 仅表示本准备适配器的元数据检查通过。

对应规格 `PI-DURIO-REDESIGN-SPEC-r1` 的 A1、A3、V2、V6。只准备这三条变化路径：

| 路径 | 真实操作与结果要求 | 准备阶段 |
| --- | --- | --- |
| coding | Terminal.app 中 `1a → 1b → 1f`，一个固定 DeepSeek 任务，保留必要检查、原文和真实退出清理事实 | NOT_RUN |
| improve | 一次真实分析，产生实际替换片段和结构化检查；在 1d 选择，验证，写回或适用的新任务生效，再只读重开 | NOT_RUN；分析授权不包含未知候选选择 |
| eval | 2b 中确认并执行一份固定的最小真实计划，保留全部 trial | NOT_RUN；本适配器用单侧诊断计划，不判改善 |

首版四类任务和 improve 闭环保持原证据与原结论，不重新执行、不改币种、不沿用旧授权。历史索引分别见 `docs/implementation/pi-durio-v1/issue-30/final-9aed1af-usd3-r3/postrun-readback/report.json` 和 `docs/implementation/pi-durio-v1/issue-30/improve-output-contract-r1/candidate-execution-plan-r1/postrun-readback/report.json`。这些引用不是新版验收证据；原失败、UNKNOWN、NOT_RUN 及后续关联结果都保留，不能改写为原批次一次通过。

## 共用身份与未来冻结

`candidateManifest` 是 #92 `pi-durio-redesign-terminal-v1` 清单的绝对路径及原字节 SHA256。直接使用其 `candidate.{commit,tree}`、`source.sourceBuildSha256`、`installation`、`harness`、`runtime`；不制造第二个候选身份。最终三票集成之后，才由未来执行者绑定**最终验收候选和独立安装**。开发分支 SHA、当前 build 或本票 synthetic 文件不能冒称该身份。

`validate` 仅读清单、完整安装/终端 harness 的普通文件与链接身份，以及 source-build 中的 `redesignLive` 接口数据（`pi-durio-redesign-live-interface-v1`）。构建从产品自身的 `improveLimits` 和 `HOST_PRICE_TABLE` 导出档位与价目，PREP 只读 JSON，不加载产品。缺少接口数据的旧构建返回 `LIVE_INTERFACE_CONTRACT_REQUIRED`，须重新构建候选。新源码不会被过期的整文件哈希误拒绝；冻结后 source-build 或安装文件变化仍使核验失败。#93 自身实际 `core.mjs`、`cli.mjs`、本 README 的绝对位置与 hash 另存入 `freeze` 输出；任何变化均使旧操作卡失效。可先把本目录复制到新的持久准备目录，再从该副本运行；不能覆盖历史冻结目录。

用户在计划、grant 或证据中直接引用的文件仍拒绝 `api.env`、`.env`、`.env.*`、`auth.json` 和 `credentials*` 文件名（不区分大小写）。仅候选 installation/harness 的逐文件哈希核对放开 `credentials*` 名称，以容纳 SDK 的 `credentials.js`、`CredentialsProviderError.js` 等普通源码；这些文件仍须匹配清单原字节，不会被导入或执行。清单中的 `api.env`、`.env`、`.env.*`、`auth.json` 仍在读取前拒绝，以保持准备工具不读取凭据的约定；工作区核对也保留完整的原文件名拒绝规则。

所有输出都以排他 `wx` 写入，已有文件拒绝覆盖。更正使用新的文件名和新的引用。准备脚本不会消费一次付费启动，也不保证用户不会手动重复运行；eval 的一次性由产品计划事实约束，coding/improve 的一次性须由执行记录核对。任何重跑须新计划、新关联和适用授权，不能重置原预算、截止点或首败。

本目录的文件名边界回归可单独串行运行：`node --test --test-concurrency=1 scripts/redesign-live/credential-names.test.mjs`；仅使用临时 synthetic 文件，不运行模型或真实工作区。

## 建立未授权材料

从仓库根或持久副本调整下列脚本位置，输出目录须已存在且为本轮新目录：

```sh
node scripts/redesign-live/cli.mjs template --kind plan --path coding --out NEW/coding-plan.json
node scripts/redesign-live/cli.mjs template --kind plan --path improve --out NEW/improve-plan.json
node scripts/redesign-live/cli.mjs template --kind plan --path eval --out NEW/eval-plan.json
node scripts/redesign-live/cli.mjs template --kind cases --out NEW/cases.json
node scripts/redesign-live/cli.mjs template --kind grant --out NEW/grant.json
node scripts/redesign-live/cli.mjs template --kind observations --out NEW/observations.json
node scripts/redesign-live/cli.mjs ref --input NEW/cases.json
node scripts/redesign-live/cli.mjs validate --plan NEW/coding-plan.json --grant NEW/grant.json
```

最后一条对原模板必须 exit 2 / BLOCKED；案例、次数、版本、人民币峰值价、预算、截止点和授权均未填写。拒绝发生在任何凭据、产品加载或派发之前。`ref` 只给普通文件的路径/hash；计划引用必须为 JSON。截图、ANSI、完整原文等通过相应证据索引 JSON 引用，原件保留。

执行前至少固定：

- 每个计划的唯一 `id`、`path`、最终共享 manifest、执行 workspace/dataRoot、模型与默认配置、source-build 原字节 digest；取得真实记录后另保存实际 `execution.config`，不能把 Git SHA 当执行版本。
- `cases.json` 中的完整新 fixture 字节、dirty 输入、lock 内容、可改路径、固定原始 input、grader 内容/版本/预期和必要要求。不要读取、复制或改动旧冻结 fixture 来冒充本轮案例。coding/improve 各一个案例、一次尝试；最小 eval 固定 case×重复及顺序，不使用默认四例。已暴露案例为公开开发数据。
- 每条路径独立的请求/token/输出/人民币估算上限、重试 0、绝对截止点、监督方式、停止条件及观察槽。`maxRequestTokens` 至少覆盖当前 1,048,576 context 加输出，并且不超过总 token 限额。
- `price` 填当前固定产品的宿主价目内容，并核对执行时仍适用。本适配器绑定 `deepseek-cny-v1`、`CNY`、查询日 `2026-10-12`、峰值输出统一上界 `8 / million tokens` 和源码中的完整 source 字符串；这只是该构建内的价目事实，不声称今天的官方价或账单。上限估算为 `maxTokens × perMillionTokens / 1e6`，不能用未知用量填 0，也不能把旧美元记录换算后当新授权。
- 每条计划单独的直接用户授权：`paidApproved:true`、完整计划文件 hash、授权者、原话、真实时间和到期时间。grant 到期不能晚于计划截止。只记录许可的环境变量名 `DEEPSEEK_API_KEY`，不保存 key、api.env 路径或内容。模板的 false/null 不由脚本补成同意。

三路径计划独立授权与分账。先前阶段的费用和首败不从新计划删除；用户审批总预算时把各阶段上限及已知/未知历史费用列清。出现 401/403、来源或版本漂移、硬要求失败、用量无可靠上界、取消、隔离/清理未知，停止受影响后续项。取消与本地清理不证明退款、远端停止或所有外部副作用消失。

### 从计划字节到实际工作区

`cases.json` 是完整案例材料，不是“已经安装”的声明。未来执行者为 coding 新建一个本轮专用目录，将 `files` 的每个相对路径按原字符串的 UTF-8 字节写入，再用 `dirty` 的同名项覆盖；这表示必须保留的初始用户改动。将 `dependencyLock` 原字节写为 `package-lock.json`。如 files/dirty 也列该文件，三者必须完全一致。`writable` 只声明任务可改路径，不授权准备脚本修改其他路径；本工具不会写工作区、安装依赖或执行 grader。新工作区不能带额外文件、node_modules、`.git`、symlink 或凭据。

improve 使用已经完成真实任务的目标目录，案例字节应在分析前固定为该目录当时的完整内容；不能把 coding 前的初态冒称分析时基线。所用 session/run、当前配置和证据来源还须在 TUI 与原记录中核对，纯文件校验不证明它们相同。eval 的 case 字节由产品固定计划带入每个独立受限 trial，host TUI 的 workspace 不是 eval 初态。

```sh
node scripts/redesign-live/cli.mjs check-workspace --plan NEW/coding-plan.json
node scripts/redesign-live/cli.mjs check-workspace --plan NEW/improve-plan.json
```

这个入口仅读取实际目录，核对完整文件集合和 SHA256；缺文件、额外文件、dirty/lock 内容不同或链接均拒绝。coding/improve 的 `validate` 及 `commands` 也调用它。`FIXTURE_BYTES_MATCH` 只说明本次读时字节相符，不证明已经运行、安装过依赖或通过任务；确认前再核对，发生漂移即停。生成卡使用校验进程的绝对 Node 路径，Node 版本/平台/架构须与共享 manifest 一致。

## 各路径的可兑现限制

### coding：固定预算与自动硬停分开

当前 `src/tui/app.ts` 的 `TuiOptions` 和 `src/cli.ts` 交互入口没有总 token、总 CNY 或绝对截止的参数；普通 coding 不接 `providerBoundary`。运行时的单任务请求限制不是全部费用硬帽。模板因此不预填 `budget.enforcement`。

若用户要求产品自动硬执行这些总限额，保持 `BLOCKED / CODING_TUI_BUDGET_NOT_EXPOSED`，保留案例、手工步骤和证据槽，交真实执行前决定；这不是本票增加产品功能或判定 #64 缺陷的授权。若用户**明确接受手动监督**，才填写 `operator-observed`，并由新 grant 的 `manualBudgetAccepted:true` 与原话支持。操作卡醒目标注该事实，不声称硬保证。不要从一般付费同意推断接受软限制。

用户在 Terminal.app 执行 `pi-durio --workspace PATH --data-root ROOT`，在 1a 粘贴固定 input，观察 1b，按固定检查验收；空闲 `/exit` 取得真实 1f。达到约定预算/截止或停止条件时用 Ctrl+C 请求停止并等待清理。非终端重开必须用 `pi-durio show <s-号|r-号> --data-root ROOT --format json`；旧 `show --run`、F2 和退出 JSON 行均不适用。不要合成 RunResult 来填退出结果。

### improve：一次分析与实际候选选择分阶段

`/improve new --scope session|7d|30d --budget standard|large --focus "…"` 只预填，Enter 才开始。当前可兑现的标准档为 16 请求、2,162,688 总 tokens、1,081,344 单请求 tokens、32,768 单次输出、600,000 ms；large 为 32 请求、4,325,376 总 tokens、1,114,112 单请求 tokens、65,536 输出、1,200,000 ms。价目上界来自宿主峰值输出价。自定义更低档位会被 `TUI_TIER_LIMIT_MISMATCH` 拒绝。

`budget.enforcement=product-analysis-tier`；相对分析计时由产品执行，外层绝对截止由“截止前留足整个档位时长”约束启动。操作卡会给最迟启动点；必须在确认前重新 validate、立即核对启动框，忙时取消而不排队。卡片不是持续监控器。scope、target session/run、focus 和现有可看项目文件均需固定，本最小方案不勾选额外 self/eval 来源、不启用 improve defaults。

`route.selection` 必须为 null。分析完成后打开 `/improve <实际 ir-号>`；零候选、仅建议、缺少替换片段/结构化检查或报告不完整都保留，不追加分析“凑成功”，执行链记证据不足。实际 1d 卡片才提供可选择内容；保存报告/候选 revision、目标/基线、替换片段、检查及数值预算、保护项、组合依赖、回退、写回与生效时机。先呈现该实际内容并取得选择授权，再在 1d 选择并核对汇总框，最后确认。分析 grant 不授权这一步；脚本故意不生成未来候选的 `--execute`。

选择预算由实际候选的结构化检查推导，不在本模板猜测。若检查需要 fresh 模型、不同安装、范围或预算超原批准，停止并固定新的真实决定。默认档位的硬限额不自动涵盖后续候选执行。执行后保留实际 diff、检查结果、清理、写回/默认/新任务或新进程生效事实；`/improve history <实际 ir-号>` 只读重开。写回、启用、检查通过和改善结论分别记录。

### eval：固定计划后从 2b 确认

新建计划仍用 `pi-durio eval plan --data-root ROOT --spec FILE`。它会加载产品、准备并固定事实，**不属于本 PREP CLI**；必须由未来执行者在案例、最终 Linux runtime、限制、价目与授权明确后单独进行。不要运行历史 live runner 或隐式使用首版四例。`--spec` 的实际结构是 `PrepareEvalOptions`：id/purpose/mode live/installation/cases/trials/budget/trialTimeoutMs/gradingTimeoutMs/maxOutputTokens/paid/price；trials 的 version 由宿主绑定。当前模板准备一个单侧最小诊断，不引入改善判定门槛或性能结论。

随后用 `pi-durio eval report <ep-号|PLAN> --data-root ROOT --format json` 导出未启动报告，作为 `route.report`。预算、价目、所有 cases/trials/repetitions/version、模型、隔离、缓存和可写范围必须与计划相符。`route.runtimeManifest` 是未来准备者的 JSON 绑定记录，含 `sourceBuildSha256`、`runtimeId`、`installationManifestSha256`、`image`、`node`、`platform:linux`、`arch:arm64`；值均取真实最终准备产物。检查此记录不证明 VM 隔离已实测，真实启动还会核对产品固定内容及边界。

`budget.enforcement=product-fixed-plan`。eval 自动检查绝对 deadline、请求/token reservation、未知用量上界，另有真实 trial/grading timeout；没有另一个整体 `maxDurationMs` 参数，模板不添加它。已启动/已停止的报告拒绝生成启动卡。`/eval run <ep-号|PLAN>` 只预填 2b 确认框；启动后留在 2b 观察全部 trial 和宿主账本。headless `eval run/grade` 会执行，不能用它替代 A1 的 TUI 入口。重评分追加 revision，原 outcome 保留；本票不增加付费 stop/regrade/exit 试次。

## 校验、冻结与操作卡

材料和真实授权齐备后，未来执行者运行：

```sh
node scripts/redesign-live/cli.mjs validate --plan NEW/eval-plan.json --grant NEW/eval-grant.json
node scripts/redesign-live/cli.mjs freeze --plan NEW/eval-plan.json --grant NEW/eval-grant.json --out NEW/eval-frozen.json
node scripts/redesign-live/cli.mjs commands --frozen NEW/eval-frozen.json --out NEW/eval-operator-card.json
```

`commands` 再核对身份、授权和期限，只输出 JSON 步骤，不派发。synthetic 清单/计划可验证拒绝和冻结处理，但不能生成真实操作卡。执行前在 Terminal.app 核对真实尺寸/环境、共享 #92 manifest 与安装内容，并确保计划指定的新 workspace/dataRoot、默认配置及固定文件未变。若读回或启动框与卡片不一致，停止当前路径。

## 证据、费用与 #94 接口

输出 `pi-durio-redesign-live-v1-report`，使用同一 `candidateManifest` 引用。计划与共享 manifest 的 `synthetic` 必须一致，否则拒绝汇总。`paths` 始终含 coding/improve/eval，各自保留 planned refs、按时间排列的全部 observations、realStatus、firstFailure；未取得真实观察为 NOT_RUN。一次 FAIL 不因后续 PASS 消失。synthetic 的 PASS 不能变成真实 PASS，也不能替代 native 观察。

每个 observation 使用模板的 `rowTemplate`，填写唯一 id、原计划 SHA、真实时间、状态、结论依据和 `evidence:[{slot,file:{path,sha256}}]`。PASS 要有该路径全部必需槽；工具只校验引用与完整性，不独立判定模型、截图或用户陈述真实性。未知/失败不得删去。修复和新试次使用新计划并保留旧 plan refs；同一计划的新读回使用新 observation，不能覆盖原件。

`cost` 保留 `knownCny:null`、`unknownRequests:null`、`complete:false` 和缺失价目，未知永不补零。已知金额必须引用宿主 `scopeId`（例如 dataRoot+run/plan 身份）、`basis:host-ledger`、实际 `through` 水位、价目版本与 cost 证据槽。重开或导入同一 scope 的较新累计快照只取最新水位求和，原观察仍保留；相同水位不同数值拒绝。若有真实计划尚无观察，总额与未知请求数仍为 null、complete 仍为 false。eval guest 的 coding mirror 不能再计一次。历史美元另列在原报告，本报表不做汇率换算。

`syntheticControls.stop/regrade/exitStop` 始终单列，初始 NOT_RUN。可引用 #82 现有适用的 offline provider / 真实 VM gate，但准确保留它各批次身份与覆盖，不拼成一次新 5/5，也不写为 native 或付费成功。本准备包的自身小型 synthetic 检查只证明方案拒绝和证据处理。

```sh
node scripts/redesign-live/cli.mjs report --input NEW/observations.json --out NEW/model-path-report-r1.json
```

#94 可直接引用该 report 的原字节 SHA、三条 `paths[*].realStatus`、逐项证据和 `cost`，并继续保留自身 A2、2c 和日用接受状态。这里不运行 A2、不生成测量数字，也不替用户接受。所有真实模型、真实 Terminal、实际候选执行、生效及用户日用当前均为 NOT_RUN。

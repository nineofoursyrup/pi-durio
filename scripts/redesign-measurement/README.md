# #94：A2 重测与日用接受准备

当前交付为 **PREP ONLY**。尚未重测、运行真实 Terminal、调用模型或取得用户日用接受。模板中的 null/NOT_RUN 不能写成 0/PASS。本目录不改产品与历史 harness；旧数值不移植到新候选。

## 三类材料

- **受控 A2**：未来用户按固定环境、负载、次数执行本目录的测量入口；计量不设隐含通过阈值。
- **日常 2c**：真实 Terminal 日常会话 `/stats --self` → `e` 的原 JSON 附件，保留整个 wrapper/来源/样本数/水位/unknown。只补“按键到重绘”，不替代受控 A2。
- **#93 三路径**：原报告/hash、coding/improve/eval 的 realStatus、所有 observation/首败与 cost 原样附入。A1 的成本事实不自动证明 A2 固定负载、重复与独立 maintenance 成本完整。旧币种不换汇，未知人民币值保持 null。

配置生成、校验、冻结、附件导入及报告处理只读输入并写到新输出。唯一可启动产品/子进程的入口是 `measure.mjs`；不要在 PREP 阶段运行它（`--verify-only` 除外）。

## 先准备最终身份和模板

#92/#93/#94 合入且相关技术检查完成后，未来执行者按 #92 README 用**最终干净源码和独立生产安装**生成新的 `pi-durio-redesign-terminal-v1` manifest。三票共用该文件的原字节引用。不能用本票开发 SHA、开发 checkout/node_modules 或旧 #92 PREP 包冒充未来生产测量身份。

以下路径均为占位符；输出父目录应已存在。脚本不安装、打包或寻找凭据。

```sh
SOURCE='/absolute/path/to/final-clean-source'
PREP='/absolute/path/to/new-A2-prep'
node "$SOURCE/scripts/redesign-measurement/cli.mjs" template --kind plan --out "$PREP/plan.json"
node "$SOURCE/scripts/redesign-measurement/cli.mjs" template --kind grant --out "$PREP/grant.json"
node "$SOURCE/scripts/redesign-measurement/cli.mjs" template --kind installation --out "$PREP/installation.json"
node "$SOURCE/scripts/redesign-measurement/cli.mjs" template --kind report --out "$PREP/report-input.json"
node "$SOURCE/scripts/redesign-measurement/cli.mjs" template --kind daily --out "$PREP/daily-input.json"
node "$SOURCE/scripts/redesign-measurement/cli.mjs" template --kind acceptance --out "$PREP/acceptance.json"
node "$SOURCE/scripts/redesign-measurement/cli.mjs" ref --input '/absolute/path/to/final-terminal-prep/manifest.json'
```

`ref` 返回 `{path,sha256}`。所有输入引用使用绝对路径和原文件 hash；manifest 的 `candidate.commit/tree` 与 `source.sourceBuildSha256` 分开。2c 的 `environment.build` 是 **source-build.json 原字节 SHA256**，不是 Git SHA。

填写 `installation.json`：kind=`independent-production-install`、node=`excluded`、nativeDependencies=`included`、devDependencies=`excluded`，提供安装命令、发生时间与原日志引用。安装统计边界为 manifest.installation.root 的完整树，须说明是否为安装前缀或包目录，不能隐去未计部分。`plan.installationEvidence` 引用该文件；`plan.distribution` 引用同构建的 `.tgz`。分发包只读解析，不解包到候选；不认识的 tar 扩展明确拒绝，不猜大小。

填写 `plan.json` 的 id、candidateManifest、全部 workload 字段、环境/过程、绝对 deadline 和实际 `nodeExecutable`。按受控目的选择并固定次数、负载与阈值策略；首版口径仅供比较：

| 字段 | 首版参考（不自动填入本轮授权） |
| --- | --- |
| startupRepetitions | help 与空库 history 各 7 次 |
| idleRepetitions / idleMs / rssIntervalMs | 3 次 / ≥30000 / 1000 |
| sessionRounds / minimumSessionMs / roundIntervalMs | 60（read/edit/check 各 20）/ ≥300000 / 5000 |
| largeOutputBytes | 1048576，之后再一次普通 read |
| queryCycles / exportRepetitions | 三种查询各 10 次 / 5 次完整输出取得写入 |
| taskTimeoutMs / processTimeoutMs / batchTimeoutMs | 由执行者固定；涵盖负载、原生宽度探查、清理和每段开销 |

sessionRounds 为 3 的倍数；大输出为 64 B–16 MiB；processTimeout 必须大于 idle/minimumSession/taskTimeout，batchTimeout 更大。`thresholds.policy` 为 `report-only-no-hard-threshold` 或 `operator-defined`（附 criteria）；脚本不替使用者裁决“轻量通过”。环境必须填写 profile、字体、负载条件、缓存策略、过程；实在未知写明 UNKNOWN 及原因，不能伪造读机结果。

先完成 plan，再生成其 ref。只有未来用户明确授权本次固定本地 A2 后，才由执行者填写 grant 的 approved、planSha256、by、原话 statement、at、expiresAt（覆盖绝对 deadline）；scope 固定为本地 A2，不包含付费/VM/日用接受。默认模板校验必为 BLOCKED。

```sh
node "$SOURCE/scripts/redesign-measurement/cli.mjs" validate --plan "$PREP/plan.json" --grant "$PREP/grant.json"
node "$SOURCE/scripts/redesign-measurement/cli.mjs" freeze --plan "$PREP/plan.json" --grant "$PREP/grant.json" --out "$PREP/frozen.json"
node "$SOURCE/scripts/redesign-measurement/measure.mjs" --frozen "$PREP/frozen.json" --verify-only
```

freeze 固定计划、新授权、本目录及所用 #92/#93 helper 内容。verify-only 在工作负载 import、产品 import、输出目录、stty、子进程之前返回。synthetic manifest 永远不能进入测量。未授权/身份漂移/过期/输出已存在均拒绝；保护源码、安装、harness 与输入原件，包括路径别名。未来重试必须新目录，不能覆盖失败半成品。

## 仅未来用户启动受控测量

在实际 macOS arm64 Terminal.app（至少 80×24）执行下面这一条；保持窗口尺寸、不要手工输入，记录干扰。它与 #92 人工观察、#93 付费路径及日用会话是不同的运行。

```sh
node "$SOURCE/scripts/redesign-measurement/measure.mjs" --frozen "$PREP/frozen.json" --out '/absolute/path/to/new-A2-run-r1'
```

顺序为 inventory → process startup → 多次 idle → controlled session → readonly query/acquisition。每段在独立 Node 子进程中运行；只保留白名单终端变量与新的 HOME/TMPDIR，不继承模型 key，不运行 eval/VM。`--worker` 是内部子进程协议，不用于跳过整批计划。每段重新核对同一冻结身份与绝对 deadline，整批另记已消耗时长，不给后续 worker 重新分配整批时间预算。

自有代码按 `src/**`（含 src/eval）物理行；测试排除 fixture/golden，全部维护脚本、随包 eval/isolation 脚本、宽度补丁分别记录。安装保留 logical/allocated-by-path/unique-inode、原生模块和不计入的外部 Node；allocated 不等于 APFS 唯一占盘。分发清单必须包含匹配的 source-build digest。

M1 保留每次 stdout/stderr、exit 与耗时；未清缓存，完整安装预检会预热缓存，不能称机器冷启动。空库 history 的 missing 覆盖原样记录。原生首帧取当前产品 ProcessMeasurements 的同步内容帧写出，避免旧标题字符串失效；不包含终端绘制。RSS 是宿主 Node 的有间隔采样，不含 Terminal/短暂子进程，不能推断绝对峰值或小时级稳定。

长会话使用本次新工作区和固定 synthetic transport，实际执行 read/edit/bash 检查；不模拟真实模型质量或费用。每轮等待 run.closed cleanup=confirmed **以及公开 screen() 的空闲 Enter 提交提示**，再允许下一轮；不靠固定等待假定 writer 已释放。固定大输出保留 `large-output-task.json` 原任务与 `large-output.json` 原文校验两个文件，后者供 query 导入。完整原文增长单列 sessions+attachments+raw-body facts 的表示副本；总量检查点也全部保留。query/acquisition 比较前后数据树，读/解码/写到 close 的时长包含本地开销，不称孤立磁盘延迟；不 fsync、不清缓存。观测/哈希开销没有分离，模型/网络时间不在这份本地 synthetic 负载中。

已尝试失败的 worker 明确 FAIL 并链接 failure.json，部分数值与首败保留；其后未启动步骤 NOT_RUN。整批保存 raw/stty 前后状态与必要修复结果。缺结果/超时/清理未知停止后续步骤。数值仅 MEASURED，不自动 PASS。

## 导入真实日常 2c 与 #93 报告

在日常真实 Terminal 进程内导出 `stats-self-<日期>.json`，填写 daily-input 的同一 candidateManifest、self 原文件 ref、provenance.user/capturedAt/原话 statement/terminal=`Terminal.app`。没有这些事实可保留 EVIDENCE_INSUFFICIENT；不能拿受控或静态 gallery 造日常证据。

```sh
node "$SOURCE/scripts/redesign-measurement/cli.mjs" attach-self --input "$PREP/daily-input.json" --out "$PREP/daily-attachment-r1"
node "$SOURCE/scripts/redesign-measurement/cli.mjs" ref --input "$PREP/daily-attachment-r1/attachment.json"
```

附件复制原 JSON **原字节**并存 hash；不调用 readSelfSnapshot、自造读机数据或改动产品。保留 at/exportedAt、buildError、所有 source/basis/samples/reason、cost.scope.asOf/through、coverage/gaps/unknownRequests/partial、原币种与未知字段；storage 缺失仍缺失。keys 是产品已聚合结果，没有逐次数组：0 样本 p50=null，不足 20 样本 p95=null，不重建或拼接多个快照的分位数。installation.samples 是文件数，不是重复次数；cost.samples=1 是一次投影，不是请求数。

report-input：controlled 引用本批 `result.json`，daily 引用 attachment.json，liveReport 引用 #93 的 `pi-durio-redesign-live-v1-report` 原文件；omissions 可逐项注明未取得原因。受控报告重核对原冻结 plan/grant/harness 的字节；历史报告可在授权到期后读取，但不能据此再次运行。缺 value 或 MEASURED 搭配 null 均拒绝。导入 #93 时重核对它引用的 observations/input 原 hash 和既有投影，完整保留三路径 realStatus/cost/首败，不再求和重复 host scopes。尚缺独立 maintenance 或固定负载成本时 cost 保持 PARTIAL/unknown。

```sh
node "$SOURCE/scripts/redesign-measurement/cli.mjs" report --input "$PREP/report-input.json" --out "$PREP/report-r1.json"
```

报告含每个 A2/U9 项、单位、状态、数值或未取得原因、全部批次/样本原件索引、环境/负载与限制。synthetic 处理结果统一 SYNTHETIC_ONLY；真实输入也只是所提供证据的汇总，报告不自动授予完整技术验收。接受模板始终“待接受”：未来用户技术验收和测量完成后实际日用，另保留明确原话、时间、最终构建与范围；提出先修正时仍待接受。本工具没有 accept 命令，不从计划/反馈/fixture 推导接受。

## 当前可运行的必要验证

仅 `test/redesign-measurement-prep.test.ts` 的小型 synthetic 文件、CLI 拒绝及语法检查；通过项目统一锁运行 build/focused。没有实际运行本目录的工作负载。真实测量、Terminal、付费、用户接受都保持 NOT_RUN。首版方法来源只读于 `docs/implementation/pi-durio-v1/issue-31/final-f26ae8f/`，旧原件和 N1 冷恢复未被改写或新增为本轮必跑项目。

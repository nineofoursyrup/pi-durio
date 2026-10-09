# #15：只读重开与恢复核对

实现 `PI-DURIO-V1-TICKETS-r1:T05`，沿用 #3 / ADR-0001 与规格 R1、R3、R5–R7、E3、E4、E10。公开 Pi 1.1.0 继续负责全部调度、工具恢复和提交；宿主新增的是预检、授权能力与追加决定，没有新 agent loop、recovery task 或 durable 私有表操作。

## 用户路径

`pi-durio show --run UUID --data-root PATH` 继续真正只读查看 host 原文；原 `result` 不变，新增可选 `recovery` 引用最近核对报告/处置/恢复结果。`readRun/readObject/readRunRecords` 原接口保持兼容。

```sh
# 只读检查：不写 source DB，不开启 Harness、模型或工具。
pi-durio recover --run UUID --data-root PATH --inspect --authorization auth.json
# 保存单独的核对报告；需要输入时退出 75。
pi-durio recover --run UUID --data-root PATH --authorization auth.json
# 对绑定的当前快照显式作出决定。
pi-durio recover --run UUID --data-root PATH --authorization auth.json --decision decision.json
```

`auth.json` 是当前授权，不从历史、模型输出或项目文本取得。普通 coding 示例：

```json
{"workspace":"/absolute/project","mode":"live","tools":["read","write","edit","bash"]}
```

只读任务的 tools 为 `["read"]`；模式、实际 workspace/root、原工具范围和有效配置必须仍适用。外部凭据可轮换，不把密钥加入身份。可选 `toolEnvironment` 沿用已有 `{version,variables}`；持久授权身份只记录版本、变量名和组合 digest，不写变量值。`--offline-demo` 要求原任务为 offline，只提供固定 README fixture transport，不做模型推理。

`decision.json` 绑定报告的 `snapshotId` 和用户提供的唯一 `id`：

```json
{"id":"continue-001","snapshotId":"<report snapshotId>","action":"continue","acceptAdditionalModelAttempts":true}
```

已证明未派发的工具可继续；Pi 保留其 unsafe interrupted 事实，宿主通过公开 passive commit 附加核对事实，再重新取得原 Submission 并等待其继续，不重发原 input。模型重试是新 attempt，沿用同一 run、原累计最多 8 次请求，不重置预算。`acceptAdditionalModelAttempts` 明确接受可能新增费用；旧 unknown/partial 不提升为零或已知总费用。

存在 `tools[].fact: unknown` 时还需逐项决定：

```json
{"id":"retry-001","snapshotId":"<report snapshotId>","action":"continue","acceptAdditionalModelAttempts":true,"resolutions":[{"taskId":3,"choice":"retry","reason":"已核对现状，明确接受重试可能重复先前效果"}]}
```

`retry` 是用户对未知风险的选择，不是先前未执行的事实。`skip`/`completed` 也是用户决定，原 unknown 不变。对已确认完成但 durable 未提交的操作，以及选择 skip/completed 的未知操作，本次 continuation 只允许 workspace 范围内的 read；模型新提出的 write/edit/bash（包括等效命令）在实际工具包装处被拒，ExecutionEnv 同时只读。进一步写作业需要结束旧工作并显式开新任务。四工具的 replay 都保持默认 unsafe；不靠 beforeTool 或提示词承担能力保证。

同一决定重复提交返回保存的结果，不再调度；同 id 不同内容被拒，过期快照被拒。决定已保存而其运行结果尚不明确时，重复决定返回需核对，不能靠重试 API 隐式再执行。后续决定仍重新核对当前事实；既有用户处置作为独立 resolution 引用，不改原事实。

## 已完成、版本变化与结束旧工作

报告区分 `committed`、`completed-uncommitted`、`not-dispatched`、`unknown`。durable Task/Entry/Submission 是执行事实；host tool.result 只是已经取得的执行返回，不能冒充 durable commit。已完成提交只读取复用，不产生模型/工具 attempt 或重复计量。缺少 host admission 回执但 durable 里存在同一 requestId 的唯一提交时可恢复原提交；缺少可关联提交时保持跨库缺口，绝不盲目再 submit。

每次接受任务保留自己的实际 build 文件、lock 内容和生产安装文件清单。恢复时重新取得并校验原 build 的保留内容与当前 build，同时逐字节核对实际在场的生产依赖文件；Node/平台/架构、有效模型/指令/工具环境、durable agent 和公开任务定义也需一致。清单 hash 本身不通过，缺文件或改变文件均拒绝。尚无 `recoveryProtocol: 1` 或原安装清单的历史仍可只读查看，不能静默迁移恢复。安装清单是约束所用原安装必须仍可取得的证据，不是离线重建承诺；它增加了接受/恢复时的文件读取成本，轻量测量由 #31 记录。

不能恢复原组合或当前权限失效时，用户可对同一报告提交：

```json
{"id":"end-001","snapshotId":"<report snapshotId>","action":"end"}
```

这会追加 `recovery.ended`，把精确原 storage 内容隔离为永不再调度的历史，不开旧 Harness、不运行 abort，也不写旧 durable 状态或原 unknown。随后可用普通 `run` 明确接受新任务；新 run/task 身份与旧历史分离。隔离后 source 内容变化仍会重新阻断，不能用旧决定覆盖后来加入的工作。

## 整个 Harness 与调度入口

在可写 storage/Harness open 前，持 data-root owner 对 quiescent main+WAL 做稳定副本，并只在副本上用公开 Storage API 分页检查全部 tasks/submissions 的身份和状态，按目标 conversation 与工具 Entry ID 读取所需文档和原文。检查完整 main/WAL 文件集合和前后 byte hashes，源库不创建 sidecar、执行迁移或被普通 SQLite/Harness 打开。临时 owner markers 是协调行为，与 source DB 只读保证分开。

只有与接受记录、原 requestId 和公开 `LiveDoc.run` 归属一致的完整任务集可获准。额外 conversation、同 conversation 的第二个 generation、background/未知 task、其他未处置 session、未知提交都会阻断。具体原因包含 `OTHER_PENDING_TASK_OUTSIDE_ACCEPTED_RUN`、`OTHER_PENDING_SUBMISSION`、`OTHER_SESSION_PENDING:<session>` 等；给用户的选项为 `inspect` / `external-verification`，退出 75。**此时 end 也不会假装解决其他工作。** 这类来源不是正常单任务 runtime 产生的可归属状态：须在产品外核实原写入者、工作归属及残留效果，保存可信证据并恢复合法一致状态；本入口不能替未知工作代为授权、取消或放行，不建议删锁/换 dataRoot 绕过它。

公开 runtime 不返回原始 Harness/Conversation/Submission。新任务的 submit/wait 先过全局 preflight；恢复的 wait 先过同一完整检查，实际模型/工具边界再次校验 owner/取消/能力；stop 时先关闭 dispatch，再调用公开 abort，所以它不能借隐式调度执行业务工具。resume/compact 等原始 Pi 方法不向 UI/CLI 暴露，不能作为 recovery action 使用。后续 #17/#19 必须接此 admission 与事实，不能自行开 Harness 或暴露原始 handles。

## 保留 owner 的处置

普通未知/崩溃 owner 不按 PID 消失或超时接管。`recover` 会把无法获取 owner 的原因/选项写为单独、fsync 的 `recovery-owner-reports/*.json`，不与活动 host/durable writer 并发写库；`--inspect` 不写这个报告。

只有原记录同时证明 storage 已关闭且全部受管命令已 settled，marker token 与原获取记录一致、原 holder 在同一本机已经退出、锁内容与当前快照未变化，并且用户明确接受仍未知的外部影响时，才允许以下处置：

```json
{"id":"owner-001","snapshotId":"<blocked report snapshotId>","action":"confirm-cleanup","acceptUnknownExternalEffects":true}
```

独立恢复 gate 防并发处置；先持久保存决定和证据引用，再归档原 marker，最后追加 `recovery.owner-settled`。重复决定幂等，活跃或换过的 owner 被拒。原 marker 内容与原 timeout/unknown 仍在；“协议 owner 已处置”不等于所有远端/外部进程已停止。之后重新 check，再单独决定 continue/end。裸 SIGKILL 没有可信关闭证据时仍 `CLEANUP_EVIDENCE_REQUIRED`，不自动删除 marker；独立外部清理/核验责任保留。

## 验证和边界

- 项目检查 `npm run check`；专属回归 `node --test dist/test/recovery.test.js`。
- 独立演示 `node scripts/demo-recovery.mjs /absolute/evidence/directory`：实际 Pi/SQLite/shell，独立文件效果 oracle，副作用前/后与已提交边界、首次落盘失败、source 不变、重复决定、全 Harness 非目标 pending 和非公开调度动作。
- 用例另覆盖 retained owner 的真实子进程正常退出/晚关闭、SIGKILL、活跃 owner，配置/权限/原内容缺失、跨库 admission 正负向、未知成本、CLI 非零结构化输入与保存。
- 正常只读 host viewer 可与 evidence writer 并发；writer 最多等待 1000ms SQLite 锁，持续锁冲突仍是持久化失败，不触发业务重试。跨进程回归与 8 并发 headless 启动探针保留原首败及修复后结果，未放宽既有信号测试。
- 所有 provider 交互都是明确 offline fixture，真实 DeepSeek/付费鉴权/计费 NOT RUN；TUI 无修改，真实 Terminal 接入属于 #17。未 push、PR/tracker 改动、main 合并、关票或发布。
- 首败日志与所有原未知事实保留；要求—证据与精确候选身份见外部 `evidence/issue-15/handoff.json`，其路径在协调运行目录 `/Users/nineofour/pi-durio-v1-run/`。

一手合同核对：[Pi 1.1.0 README](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/README.md)、[ToolTask recovery](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/harness/tool.ts)，并阅读本次实际安装的公开 `.d.ts` 和发布 `.js`。使用的 Storage scans、LiveDoc、ToolTask/GenerationTask checkpoint 是公开导出合同，不读取 durable 私有 SQL schema。

2026-10-10 的 SPEC-01 有界 host/admission 修复、验证范围与目标 session 恢复的后续边界见 [preflight-memory-repair.md](preflight-memory-repair.md)。原验收与首败文件保持历史身份，不以新候选覆盖。

目标 session、普通关闭、压缩撤回和存储管理的后续有界投影与分页接口见 [target-session-projection-repair.md](target-session-projection-repair.md)。

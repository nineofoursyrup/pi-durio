# 固定候选证据索引 r2

候选 `9aed1af6ee3b156bb7354961496217aa5e64843e`，tree `d76896b400bb90c3beb82d847d9b43ba86fc5a07`。状态：`PARTIAL_TECHNICAL_ACCEPTANCE_NOT_COMPLETE`。

本版保留 r1 的 62 条合同、22 条 ACC、7 条 MET 及每行原始字段/状态，只追加 `r2_observation`。原 `pending_gates` 是保留的历史基线；本节 current gates 和逐行新增范围说明目前已取得什么、仍缺什么。所有行均不因相关步骤成功而自动升级为整条合同 PASS。完整原文、测试/评审/hash/票据映射见 `contract-evidence-index-r2.json`；本文件末尾另原样保留 r1 可读索引。

## 当前证据与门槛

| 门槛 | 当前状态 | 适用范围及缺口 |
| --- | --- | --- |
| native | PLANNED_AUTOMATED_NATIVE_WORKLOAD_EVIDENCED_WITH_PRESERVED_FIRST_FAILURE | Original idle×3 and long/large/next-task plus successful composition/readonly follow-up; synthetic transport, actual macOS Terminal 112×35. Prior manual #16 candidate-specific IME/keys/copy/small-grid results remain preserved; final-candidate human applicability is not automatically accepted. Text app.screen frames are not external screenshots. |
| paid | STOPPED_INCOMPLETE | Real eval planned4 started2 completed1 gradable1 passed1; multi-file execution_error/TASK_UNANSWERED, grade unknown; regression/no-change not-run. Real four-case acceptance and real improve analysis/selection/verification/writeback-or-effective/reopen chain incomplete. No new paid start is authorized by this index. |
| measurement | LOCAL_MEASUREMENTS_RECORDED_REAL_PROVIDER_COST_PARTIAL | Existing inventory/startup/headless plus native startup/idle/long/large/readonly records; actual started eval cost only. Real improve cost and complete representative real workload remain unavailable. No numerical lightweight threshold or unbounded-time memory guarantee; invoice is UNKNOWN. |
| daily_acceptance | NOT_ACCEPTED | No explicit user daily-use acceptance is recorded by these technical runs. #32 user trial and explicit daily-use acceptance remain distinct from automated fixture actions and technical readback. |

native 原轮保留 `MEASURED_WITH_FAILURES`：idle×3、60 个节拍普通任务加 1 MiB 输出及后续任务有实测，composition 因 `IMPROVE_REPORT_NOT_FOUND` 首败，readonly 当时未运行。follow-up 仅补 composition 和 readonly：前者 `PASS`（7 synthetic/0 real 请求），后者 30 查询加 5 次完整输出获取；3067 项源清单一致。两轮都是真实 macOS Terminal 内的自动化，不能代替人工 IME、复制、鼠标、40×12 或日用接受。

真实 #30 USD3 r2 为 `STOPPED / BATCH_TRIAL_NOT_PASS`。计划 4、启动 2、正常完成 1、可评分 1、通过 1；通过率 1/1、完成率 1/4、覆盖率 1/4。local-fix PASS；multi-file 的产品 `TASK_UNANSWERED` 对应 eval execution_error，grader 启动前取消而 UNKNOWN；regression 和 no-change 未运行；真实 improve 未运行。

已发生 eval 的 host 最高档估算为 USD **0.0329988**（15 请求、27499 tokens），包含失败 8 请求/14129 tokens 的 USD **0.0169548**。价格版本 `DeepSeek-public-2026-10-09-maximum-class`，1.2 USD/百万 tokens。guest pi.usage 使用另一 catalog 价目，是同请求镜像，不与 host 重复相加。该金额不是账单实付、完整四例或 improve 总费用；远程请求终止 UNKNOWN。

本轮只读取/hash 核对已有证据并生成文档，未启动 provider、VM、build、产品测试或 Terminal。

## 62 条合同新增适用性

| ID | 保留的 r1 状态 | 本轮直接范围 | 未被本轮补齐的范围 | 证据 ID |
| --- | --- | --- | --- | --- |
| S1 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | macOS arm64 的 Apple_Terminal 488.7、112×35 实测补齐已声明的 native 工作负载；本机测量与真实 eval 部分费用分别有来源。 | 没有预设数值门槛；这些数据不证明整体轻量、长期稳定或日用接受。真实 improve 费用与完整 #30 路径仍缺。 | native-original, native-followup, local-measurements, paid-eval |
| S2 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 两轮 native 与付费批次均绑定同一 9aed1af 产品工件；sourceBuild 和安装身份沿用已有证据。 | 本轮没有重新安装、升级依赖或重新审计公开 API；源码与 npm 发布来源仍依照原工件合同，不由相同版本号推断。 | native-original, native-followup, paid-artifact |
| S3 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native TUI 普通任务/压缩/improve 与受限 headless eval 分别实际经过产品入口；保留各自结果与工具事实。 | 两种入口使用不同 fixture 和能力配置；本轮不是同一案例的 TUI/headless 差分对照，语义等价仍须结合原测试/评审。 | native-long, native-composition, paid-eval |
| S4 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 真实 eval 请求 deepseek/deepseek-flash，返回标识为 deepseek-flash；已发 15 请求、记录已知 usage。 | 返回别名不是不可变权重证明；没有新增失效凭据/端点漂移/泄漏注入验证。真实 improve 未运行。 | paid-plan, paid-eval, paid-stop |
| S5 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | native harness 记录继承环境变量名；真实 eval 与 synthetic improve 验证运行于声明受限环境。 | 不能从名义隔离或普通成功执行外推所有工具环境不泄漏；本轮没有新增秘密泄漏攻击测试，也不承诺本机同用户绝对隔离。 | native-followup, paid-artifact, paid-eval |
| S6 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地单宿主 Node 进程的 RSS 与查询测量可追查，没有新增服务。 | 没有新增多写入者/服务部署验证；Host Node RSS 不含 Terminal、子进程和所有瞬时峰值。 | native-original, native-followup |
| R1 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | synthetic improve 从未选到结构化 execute 决定后才执行声明的 math.mjs 范围与隔离回归；真实 eval 按固定计划运行。 | 这不是恢复重放、恶意文本或等效新调用绕权的新增攻击证据；原有边界测试/评审仍须按适用范围读取。 | native-composition, paid-plan, paid-eval |
| R2 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 顺序运行和正常关闭有记录；没有观察到本批自身并发写入冲突。 | 未启动第二 owner、别名/重叠根、陈旧锁或残留进程抢锁场景；不能把无冲突当成锁合同验证。 | native-followup |
| R3 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 30 次只读查询和 5 次完整输出获取前后 3067 项源清单相同；读取不新增 synthetic/real 请求。 | 未新增受限恢复核对或全 Harness pending 混合路径；sourceUnchanged 只覆盖所测目录/操作。 | native-readonly, native-composition |
| R4 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | native 每步结束 TTY 设置相同且无需修复；两例真实产品均保存 cleanup=confirmed、storage=closed、受管命令 settled。 | 付费批次 remoteTermination=unknown；产品 externalProcesses=unknown。正常关闭不证明远端或全部外部进程已停；本轮没有新增所有退出/中止交互。 | native-original, native-followup, paid-local-product, paid-multi-product, paid-stop |
| R5 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 原 native harness 首败和真实产品 TASK_UNANSWERED 均保留。 | 这两种失败不是工具副作用已发生而提交缺失的恢复场景；本轮未重启、重放或作出幂等核对结论。 | native-first-failure, paid-multi-product |
| R6 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 继续使用同一产品候选及 sourceBuild 身份；仅 harness polling 修正，产品未重建。 | 没有跨版本 pending 迁移、不可取得工件或凭据轮换的新增恢复验证。 | native-followup, paid-artifact |
| R7 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 真实 headless 失败产品保存 TASK_UNANSWERED 与清理事实；批次以 STOPPED 和 BATCH_TRIAL_NOT_PASS 结束，未无限继续。 | 没有新增需用户决定后显式恢复场景；失败前 8 次真实请求有成本，远程停止仍未知。 | paid-stop, paid-multi-product |
| T1 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 112×35 的 native app.screen 文本帧及自动键位序列覆盖会话、详情和 improve 流程接线。 | 文本帧不是外部像素截屏；本轮未重新观察鼠标滚动/选文/复制、帮助全路径或人工布局验收。旧 #16 人工结果仅适用其原候选/场景。 | native-composition, native-original, prior-human-r6 |
| T2 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 62 个普通任务、1 MiB 分块输出、随后任务，以及压缩/候选/执行状态均有受理和完成记录；保留有限显示/原文引用。 | 有限时长采样不能证明永远有界；没有新的 40×12、上滚焦点或草稿竞争人工验证，旧人工证据不可自动提升至最终候选。 | native-long, native-composition, prior-human-r6 |
| T3 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native 顺序普通提交及 improve 结构化选择实际接线可追查。 | 本轮没有在忙时竞争注入 steer/follow-up、撤回或 task 身份切换；顺序任务不能代替队列边界测试。 | native-long, native-composition |
| T4 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native 首败后只读步骤未运行；付费失败后保留 regression/no-change 未运行。 | runner 停止不是产品冻结 steer/follow-up/manage 队列的直接验证；本轮未新增解冻或恢复测试。 | native-first-failure, paid-stop |
| T5 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 最终长会话源上的只读查询和取原文不改变源数据。 | 没有新增历史视图误提交、切执行工作区、中止目标或恢复面板交互的 native 证据。 | native-readonly |
| T6 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native 自动键位驱动候选选择、提交和正常退出；原 #16 r6 人工键位记录及首败仍保留。 | 本轮不是人工 Chinese IME、组合候选、不误提交、Ctrl+C/Ctrl+D 全时序或弹层焦点验收；这些旧结果的最终候选适用性未由本索引认定。 | native-composition, prior-human-r6 |
| T7 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 真实 macOS Terminal 中所有已运行步骤 TTY before/after 一致，repair=false；宽度探查与输入保留有记录。 | 真实终端内的自动脚本仍不替代人工 IME、字符格、键码、复制及完整进程清理验收；无新增 SIGKILL/掉电承诺。 | native-original, native-followup, prior-human-r6 |
| E1 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 1 MiB 输出和压缩前 90000 个 z 的实际原文有 hash；真实请求/响应、usage 与失败结果保留。 | 只证明实际取得和记录的这些内容；不承诺不可见思维、未返回 payload 或全部网络字节。 | native-long, native-composition, paid-eval |
| E2 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 1 MiB 输出由 64 块保留并完整获取，5 次导出 hash 一致；显示帧、源原文、压缩摘要分别保留。 | 未新增磁盘满/损坏/暂时不可读注入；RSS 增长有限采样不能证明长期上界或无泄漏。 | native-long, native-readonly, native-composition |
| E3 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | source task、compaction、analysis、selection、execution 与后续 read 以及四个 eval trial 的身份和状态分别可追查。 | 没有新增跨重启、身份缺失或事实/反馈修订竞争；真实 multi-file 执行失败与评分 unknown 必须分开。 | native-composition, paid-eval, paid-multi-product |
| E4 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 原文/host SQLite/对象引用留存，读取前后清单不变；决定和执行结果分别存在。 | 没有新增断电、跨库提交间隙、权限或 WAL 迁移测试；不据正常运行推断 exactly-once。 | native-readonly, native-composition |
| E5 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 报告保留失败而未重标成功。 | native 首败为 harness 读取尚未存在的 improve 报告，不是必需记录落盘失败；本轮没有必需存储失败或 telemetry 降级注入。 | native-first-failure, paid-stop |
| E6 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | synthetic 与真实 usage 分开；真实 host 计 15 请求/27499 tokens，含失败 8 请求/14129 tokens；guest coding 是同份 eval usage 的镜像。 | host 固定最高档估算与 guest catalog 估算是不同价格口径，不能相加；非账单实付，无真实 improve 费用，本轮没有缺 usage 或 SDK 不可见重试验证。 | native-original, native-followup, paid-eval, paid-local-product, paid-multi-product |
| E7 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | manual compaction 有请求、已提交摘要和 state=applied；原 90000z 回复保留，后续 improve/普通任务实际继续。 | 没有新增忙时排队/去重/automatic compaction 的竞态；synthetic 摘要不证明真实模型压缩质量或收益。 | native-composition |
| E8 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 区分摘要提交和 compaction applied，原文仍可读取。 | 没有取消与接入竞争、过期摘要、自动成本归属或失败压缩的新场景；上下文减少不代表磁盘释放。 | native-composition |
| E9 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 源清单前后相同，未执行删除。 | 本轮没有归档还原、保护依赖清理、WAL 迁移或主动丢弃原文；只读成功不证明全部保留/迁移合同。 | native-readonly |
| E10 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 30 次分页/原文查询和 5 次 1 MiB 完整导出有范围与耗时；源未变化；synthetic improve 读取声明来源生成报告。 | 30 次样本不覆盖所有筛选组合或敏感片段；真实 improve 未运行，没有新增外发脱敏攻击验证。 | native-readonly, native-composition |
| V1 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 固定四类 TypeScript/Node trial 均保留：local-fix PASS，multi-file execution_error/grade unknown，其余两类 not-run。 | 只完成 1/4 且只评分 1/4；四类代表任务的真实验收仍未完成。 | paid-eval, paid-stop |
| V2 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | USD3 r2 固定 manifest、候选、案例、限额、顺序和截止时间；本轮未扩大或重启。 | 这是 candidate-only 代表任务批次，没有 baseline 对照或性能判定门槛，不能证明改善。 | paid-plan, paid-eval |
| V3 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 已启动 trial 的独立环境/身份与准备、任务、评分时间分别保留；native 回归独立于付费批次。 | 没有两侧配对、顺序交替或随机重复；没有由本轮证明普遍无污染或总体稳定。 | paid-eval, native-composition |
| V4 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | synthetic 候选验证实际在受限 Linux arm64 环境运行并清理；真实 eval 保存 execution/isolation 记录和 host 中介请求。 | 普通执行/清理与已存在边界检查结合使用；本轮未新增篡改评分、读取隐藏答案、网络或逃逸攻击，不能由名义配置单独宣称全边界通过。 | native-composition, paid-artifact, paid-eval |
| V5 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | native signed-addition 回归有受限执行与产物；真实 local-fix scope/task 必需检查 PASS。multi-file 执行失败，其 grader 启动前取消而 unknown。 | 不能把 grade unknown 写成候选 FAIL 或 PASS；没有新增全部越界导出与污染测试。 | native-composition, paid-eval, paid-multi-product |
| V6 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 失败后批次 STOPPED，不重开；全部计划保留，失败 8 请求计入 15 请求总额；improve 与后两类未运行。 | remoteTermination=unknown 不代表退款或计费停止；预算内已知费用不代表全部计划完成，也不是允许自动续跑。 | paid-plan, paid-eval, paid-stop |
| V7 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 只对首败 composition 和原未运行 readonly 作 targeted follow-up；复用原 idle/long 证据；signed-addition 使用实际回归。 | 本索引仅静态读回和映射，不新跑测试；synthetic fixture 修复不是模型策略 A/B 改善证据。 | native-first-failure, native-followup, native-composition, paid-eval |
| V8 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | native 检查通过、requiredBenefitCount=0、allDeclaredBenefitsMet=false 分开保留；真实 eval improvement=not-evaluated。 | 无 baseline 配对或预定收益门槛；不能以单例 PASS、低费用、写回成功宣称改善或无明显差异。 | native-composition, paid-eval |
| V9 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 计划 4、启动 2、正常完成 1、可评分 1、通过 1；S/G=1/1、C/N=1/4、G/N=1/4；失败和未运行均展示。 | 适用范围仅本批固定案例/受限环境；没有重评分修订或两侧有效配对，不外推普通宿主或总体成功率。 | paid-eval, paid-stop |
| I1 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | synthetic improve 分析生成 1 个未选候选，随后由独立结构化决定进入执行；没有自动执行分析输出。 | 真实 improve 因 eval STOPPED 尚未运行；synthetic 分析不能满足 A1 的真实分析要求。 | native-composition, paid-stop |
| I2 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 保存 report/candidate revision、math.mjs 范围、验证、预算、writeback/enable 条件和明确 synthetic 缺口。 | 单候选不能证明所有依赖/冲突/反例合同；预填 synthetic 内容不等于真实模型发现候选。 | native-composition |
| I3 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本次只修改已声明 fixture 的 math.mjs；报告说明 self source 未登记，未寻找或修改安装包。 | 未执行 runtime/tool/config/skill/eval 资产候选；不能从 fixture 文件推广这些对象的启用验收。 | native-composition |
| I4 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 报告最初 selected=[]；自动 e/s/Enter 键序列形成绑定 revision 的 execute 选择并完成一次提交。 | 这是授权测试脚本的选择接线证据，非用户对真实候选的人工作出选择；未新增 R2 暂缓、validate-only、重复提交或漂移验证。 | native-composition |
| I5 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | execute 模式在受限临时环境作 signed-addition 验证后写回 fixture。 | 本次不是 validate-only 模式；不能据 enable=false 将它改称仅验证，也未验证配置即生效对象的准备路径。 | native-composition |
| I6 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 原候选及决定可追查。 | 本轮没有暂缓、不再建议、主动恢复或同问题换 ID 场景；抑制合同仅沿用原适用测试/评审。 | native-composition |
| I7 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native 单候选批次完成，付费代表任务批次在失败后停止。 | eval 停止不是多候选 improve 组合失败的直接验证；本轮没有多项依赖、组合、部分写回或显式继续。 | native-composition, paid-stop |
| I8 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 验证后实际 fixture math.mjs 从 a-b 写为 a+b，README 保留；后续普通 read 工具读到 a+b；activation=not-enabled。 | 没有启动新 runtime build/进程或设置默认；requiredBenefitCount=0，不证明性能改善；实际新任务读取 fixture 不等于 runtime 热升级。 | native-composition |
| I9 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本次写回限于声明 fixture，保留 README 与旧内容/证据。 | 本轮未执行回退、补偿或用户并发编辑冲突；未包含 commit/push/release/cleanup 产品动作。 | native-composition |
| I10 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 候选选择、执行完成、正式 fixture 写回、not-enabled 与效果标志分开；原首败和后续成功均保留。 | 没有真实 improve 闭环或模型因果收益；只读回报告不等于已实测重开产品 UI 不重复应用。 | native-composition, paid-stop, paid-eval |
| M0 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | native 受理任务与 eval 四个计划 trial 分开，全部未运行项仍在计划，未把 synthetic 任务加进真实 eval。 | 不是日常受理时间窗统计、跨重启/反馈修订的新增端到端验证；两类分母不可合并。 | native-long, paid-eval |
| M1 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本批 N=4、B=2、C=1、G=1、S=1；分别报告 S/G=1/1、C/N=1/4、G/N=1/4，multi-file 正常清理但执行失败/不可评分。 | 1/1 不是全部计划成功率；没有证明真实日常任务总体成功率或矛盾反馈修订。 | paid-eval |
| M2 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | host 已知 15 请求、27499 tokens，USD 0.0329988 包含失败 USD 0.0169548；仅当前已发生 eval 部分估算，不重复加 guest 镜像。 | 真实 improve/未运行两类成本未取得；不是完整批次/日常成本或实际账单。不同价目估算分开，不把未运行成本 null 解释为成功零成本。 | paid-eval, paid-local-product, paid-multi-product |
| M3 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | native performanceMs、步骤耗时及真实 eval preparation/task/grading 单调时钟分开；来源明确。 | 首次帧不是进程出生到可见像素；eval task 包含 VM/runtime 开销，不是纯模型活跃时间。没有用户最终验收时钟或跨重启等待全分段。 | native-original, native-followup, paid-eval |
| M4 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 自动脚本的选择与真实执行记录存在。 | 自动化步骤、日志完整或没有投诉都不能证明整阶段无人工介入；没有新增完整阶段覆盖，介入率 UNKNOWN。 | native-composition, paid-eval |
| M5 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | synthetic 修复有实际回归，真实批次保留独立 regression 类 not-run。 | 没有 baseline/candidate 保护配对，不能算新增回归率；没有成熟 7 天交付窗，不能把无反馈记为无返工。 | native-composition, paid-eval |
| M6 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | native harness 的 IMPROVE_REPORT_NOT_FOUND 首败保留且由后续读回补充；真实 multi-file 为 TASK_UNANSWERED/execution_error，grader cancelled/unknown 分列。 | harness 故障不是产品运行故障的同一分母；后续 synthetic PASS 不抹去首败，也不能外推日常产品故障率或猜 SDK 内部 attempts。 | native-first-failure, native-followup, paid-eval, paid-multi-product |
| M7 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 追加 r2 的可读/机器可读映射，一并引用原报告和后续证据；只做静态读取不新增模型调用。 | 本索引不是新的日常反馈采集或产品 report 命令执行；全部算术/六示例的行为依据仍是原适用检查。 | native-disposition, paid-eval, paid-stop |
| A1 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native synthetic 接线/组合工作负载已有原轮与成功补跑；真实 DeepSeek coding local-fix 完成并通过。 | #30 仍不完整：multi-file 失败、两类未运行、真实 improve 分析→用户选择→验证/写回/重开未运行；不能宣告技术验收完成。 | native-original, native-followup, paid-eval, paid-stop |
| A2 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 补充本机 native startup/idle/long/large/readonly 数据，以及已发生真实 eval 部分费用；统计边界和原始重复可追查。 | 没有事先数值阈值，不据数字自动称轻量；真实 improve 成本、完整技术验收与用户明确日用接受仍缺。 | local-measurements, native-original, native-followup, paid-eval |
| A3 | PROCESS_BOUNDARIES_RECORDED_DELIVERY_INCOMPLETE | 状态为 PARTIAL_TECHNICAL_ACCEPTANCE_NOT_COMPLETE；原 native 首败、后续成功和真实 STOPPED 并列。 | #30 未完成；#31 只能完成已声明测量/证据整理范围，不能据此关闭所有技术门槛；#32 日用接受、首版完成和发布未成立。 | native-disposition, paid-stop |
| A4 | PROCESS_BOUNDARIES_RECORDED_DELIVERY_INCOMPLETE | 沿原证据顺序追加 final native 与真实 eval 读回，早期身份/原文/首败保持可追查。 | 此次文档整理不回填不存在的早期观测，也不将真实 improve 或本机试用当成已经完成。 | r1-json, native-disposition, paid-eval |
| A5 | PROCESS_BOUNDARIES_RECORDED_DELIVERY_INCOMPLETE | 只修正外部 harness 的报告等待，再补 composition/readonly；付费失败停止并留存，产品 9aed1af 不变。 | 没有扩大预算、放宽保证、更换核心依赖或重新开启 paid run；进一步执行须使用其适用授权和新证据。 | native-first-failure, native-followup, paid-stop |

## 22 条 ACC 新增适用性

| ID | 保留的 r1 状态 | 本轮直接范围 | 未被本轮补齐的范围 | 证据 ID |
| --- | --- | --- | --- | --- |
| ACC-01 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | TUI/native 与 headless/eval 分别实际运行产品入口。 | fixture/配置不同，不是同案例双入口差分；等价合同仍需原 S2/S3 证据。 | native-long, native-composition, paid-eval |
| ACC-02 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 正常单写入者顺序运行和关闭。 | 未新增两个进程竞争同一 storage；不能从无冲突推断第二 owner 被阻止。 | native-followup |
| ACC-03 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 不同运行首败保留，未重写为成功。 | 未在工具边界中断并重启；不能替代 replay 合同证据。 | native-first-failure, paid-stop |
| ACC-04 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | TASK_UNANSWERED 及已取得产物保留。 | 不是副作用已发生而提交缺失的核对场景；无新增幂等/处置验证。 | paid-multi-product |
| ACC-05 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 查询/导出前后 3067 项源清单相同，不新增请求。 | 没有新增恢复重放或重开 TUI 的计量回归；只覆盖这些只读操作。 | native-readonly |
| ACC-06 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 真实/合成请求有终止与 usage 记录。 | 本轮没有逐 span 生命周期与 completeSimple 双计的新增直接观测。 | native-original, paid-eval |
| ACC-07 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 15 个已发请求 usage 已知，未运行 trial metrics 为 null；完整验收仍 partial。 | 未注入 provider 缺 usage；不能从这些完整返回推断遗漏处理已新增实测。 | paid-eval, paid-stop |
| ACC-08 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本轮观测/查询正常完成。 | 没有 exporter 故障注入或缓冲耗尽场景。 | native-followup |
| ACC-09 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 固定 candidate-only 案例/版本/初态和隔离结果可追查。 | 没有 baseline 侧与配对；无法补齐本条真实比较部分。 | paid-plan, paid-eval |
| ACC-10 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 声明受限执行和清理事实可追查。 | 没有新增候选篡改 grader/读取隐藏答案攻击；名义隔离不是攻击通过结论。 | native-composition, paid-eval |
| ACC-11 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 62 个普通任务对应 124 个 synthetic 请求，没有额外 retro/critic 自动请求记录。 | 只覆盖该 fixture workload；真实 eval 的分析/反思行为不能按名称猜测额外请求。 | native-long |
| ACC-12 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | synthetic 分析先保存 1 个候选且 selected=[]，再由独立 execute 决定动作。 | 原文 retro 保留；正式合同称 improve。真实 improve 未运行，不能用后续授权写回否认分析阶段只读边界。 | native-composition, paid-stop |
| ACC-13 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 候选有 synthetic 局限说明。 | 本次产生 1 候选，不是零候选路径的新验证。 | native-composition |
| ACC-14 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 执行 1 个声明候选并保存决定。 | 不存在第二个 R2 暂缓项，不能声称本条完整选择/暂缓场景被覆盖。 | native-composition |
| ACC-15 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | execute 模式完成验证后写回 fixture，enable=false。 | 不是 validate-only；not-enabled 不等于未正式写回。 | native-composition |
| ACC-16 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 选择和执行绑定所保存的 revision。 | 没有人为改变候选/基线，未新增 stale-choice 拒绝验证。 | native-composition |
| ACC-17 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 保存当前单次决定。 | 没有不再建议/换 ID/升级后抑制场景。 | native-composition |
| ACC-18 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 验证后的 fixture 文件写回并被新普通任务读取；产品工件仍 9aed1af。 | 不是 runtime/tool build 启用；未验证新进程生效或旧 pending 迁移。 | native-composition, paid-artifact |
| ACC-19 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 决定、执行、写回、not-enabled 和效果字段分开；真实 improvement=not-evaluated。 | requiredBenefitCount=0、allDeclaredBenefitsMet=false；不宣称优化有效或无明显差异。 | native-composition, paid-eval |
| ACC-20 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 真实 Terminal 测得长会话、大输出、正常退出 TTY 恢复；宽度/帧事实存在。 | 有限 RSS 采样不证明永远无界限增长；无最终候选人工 Chinese IME/复制/40×12 完整重验。旧人工结果不自动迁移。 | native-original, native-followup, prior-human-r6 |
| ACC-21 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 声明权限和阶段结果保持可追查。 | 本轮未注入仓库/trace 指令样恶意文本；仍依原相关测试/评审。 | native-composition, paid-eval |
| ACC-22 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 数据附工作负载、机器/Node/Terminal、计时/RSS/费用边界。 | 没有数值阈值或因果对照；真实费用为 partial，不能据低数值声称轻量/改善或替代日用接受。 | local-measurements, native-original, native-followup, paid-eval |

## 7 条 MET 新增适用性

| ID | 保留的 r1 状态 | 本轮直接范围 | 未被本轮补齐的范围 | 证据 ID |
| --- | --- | --- | --- | --- |
| MET-01 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 日常形态 synthetic workload 与 eval 四计划 trial 分开；真实 N4/B2/C1/G1/S1，三率明确。 | 不混入日常真实成功率，未运行/无法评分保留；不是所有恢复身份和零分母的新运行。 | native-long, paid-eval |
| MET-02 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | host USD 0.0329988 含失败 USD 0.0169548；guest 镜像另有 catalog 价，不能重复相加。 | 账单实付 UNKNOWN；真实 improve/全部四类费用不完整；null 的未运行指标不代表零成本成功。 | paid-eval, paid-local-product, paid-multi-product |
| MET-03 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地帧/步骤计时与 host eval preparation/task/grading 分开。 | 无用户验收时钟；task 含 VM/runtime，首次帧非进程出生到屏幕像素；未知分段不造零值。 | native-original, native-followup, paid-eval |
| MET-04 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 结构化选择/授权动作可定位。 | 不是纠错介入阴性证据；完整阶段无介入覆盖未取得，未知不能按零计算；原反馈规则仍复用本地确定性检查。 | native-composition, paid-eval |
| MET-05 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 保留 synthetic 回归与真实 regression 类未运行。 | 无 baseline/candidate 保护配对；无成熟 7 天真实交付覆盖，不由无反馈推断无返工。 | native-composition, paid-eval |
| MET-06 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | harness 首败、产品执行失败与 grader unknown 分开保存；成功补跑不抹去首败。 | 不同故障分母不可混算；没有总体日常/模型稳定性样本，SDK 内部 attempts 未猜测。 | native-first-failure, native-followup, paid-multi-product, paid-eval |
| MET-07 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | 同源生成 JSON/Markdown、91 行映射和静态保存性检查；来源/hash 与范围可追查。 | 静态一致性不是重新运行产品六个算术示例；沿用适用确定性检查，不触发模型/业务。 | r1-json, native-disposition, paid-eval |

## 新增引用目录

JSON 中每个引用均保存绝对路径、bytes 和 SHA-256；以下链接读取同一固定来源。

- `r1-json`：[来源](/Users/nineofour/pi-durio-v1-run/evidence/issue-31/final-9aed1af/contract-evidence-index.json) · 262960 bytes · `6eb89a362b05918b070b782deec78c597612439a8dea0c79a44dcb19bf580122`
- `r1-md`：[来源](/Users/nineofour/pi-durio-v1-run/evidence/issue-31/final-9aed1af/contract-evidence-index.md) · 7251 bytes · `15e83cab1b9ec029834cfefac322f1a001aa5c0762d05750771a153bcfe420a9`
- `native-original`：[来源](/Users/nineofour/pi-durio-v1-run/evidence/issue-31/final-9aed1af/native-summary.json) · 46845 bytes · `cf9457281285f8d5bdc76fd5f8604136dedb3235e61877e5a4780fcf92ec02dc`
- `native-first-failure`：[来源](/Users/nineofour/pi-durio-v1-run/evidence/issue-31/final-9aed1af/native/composition/failure.json) · 5680 bytes · `cf3c34090a4b138b1676343b05a5fa13fbce2bd2493badceb700263cdc5d2c8a`
- `native-long`：[来源](/Users/nineofour/pi-durio-v1-run/evidence/issue-31/final-9aed1af/native/long-session/result.json) · 930461 bytes · `1fb56666475f780092e95270a4992493a8967ac3df726f4123c2a9a49bbdcccf`
- `native-followup`：[来源](/Users/nineofour/pi-durio-v1-run/evidence/issue-31/final-9aed1af/native-followup-r1-summary.json) · 87837 bytes · `a508257a7d366a69f490e43f1b8c94ba33b49065328b7a2c624e6e5a7640c03d`
- `native-composition`：[来源](/Users/nineofour/pi-durio-v1-run/evidence/issue-31/final-9aed1af/native-followup-r1/composition/result.json) · 89966 bytes · `f8ff08d6ffb52ef1ad19983ff95b9ec47495cd79917dd9da2ef5ef648b4957fb`
- `native-readonly`：[来源](/Users/nineofour/pi-durio-v1-run/evidence/issue-31/final-9aed1af/native-followup-r1/readonly-data/result.json) · 21873 bytes · `5783357ebe52b3fe111bba59910d6dd618e9a38459613cb6fcd1d2cd2c18c5c2`
- `native-disposition`：[来源](/Users/nineofour/pi-durio-v1-run/evidence/issue-31/final-9aed1af/native-evidence-disposition-r1.json) · 5387 bytes · `87275adc9e96ea57d2266965d3ff4f42a34edf7dda64649f3529d8d5a024c2e3`
- `prior-human-r6`：[来源](/Users/nineofour/Durio/docs/implementation/pi-durio-v1/issue-16/acceptance-r6.json) · 4392 bytes · `4c60fd3dd5476bf1bbeb869b4fbc97c849a63073d47ce087631421d693089365`
- `local-measurements`：[来源](/Users/nineofour/pi-durio-v1-run/evidence/issue-31/final-9aed1af/partial-summary.json) · 24287 bytes · `1084eaca7169014231e379b6988c854d8c54292a1b355e081c83990ae2ff7bda`
- `paid-plan`：[来源](/Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af-usd3-r2/frozen-manifest.json) · 8105 bytes · `51ff05f19a55cd14653f1f00dc7a07d4bc5f9931b7107091ad5207ce0e269486`
- `paid-artifact`：[来源](/Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af/artifact.json) · 1905 bytes · `a1c8fb0660266c7758335a31a8773396294e3fc86d550a479be53ea2b344647b`
- `paid-stop`：[来源](/Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af-usd3-r2/batch-result.json) · 465 bytes · `44fcd0fcc08784463c157329cb4bbeff00f8981762cf16273dfe42c6b9688c7f`
- `paid-eval`：[来源](/Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af-usd3-r2/live-eval-result.json) · 713898 bytes · `be42c821efef34d0bd9adc13696057a666432c823385db9ee1246e657cbc6669`
- `paid-local-product`：[来源](/Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af-usd3-r2/live-eval/v1-live-r1-local-fix-execution/work/product-result.json) · 2703 bytes · `2d397957e4af4f0a7d1e33e431190e2b9280fc38b9fce5256041a32a8547a1e4`
- `paid-multi-product`：[来源](/Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af-usd3-r2/live-eval/v1-live-r1-multi-file-execution/work/product-result.json) · 1891 bytes · `32e5fddc74eebc4a7c0e9fc93c982bc42952a436f103425a89b17c52f5860ed9`

## r1 历史可读索引原文

以下是原 `contract-evidence-index.md` 的完整未改写内容，字段和 pending 表示当时基线；当前状况使用上方 r2 门槛与逐行范围。

<!-- BEGIN IMMUTABLE R1 MARKDOWN -->
# 固定候选证据索引

候选 `9aed1af6ee3b156bb7354961496217aa5e64843e`。62 条合同、22 条 ACC 和 7 条 MET 均保留。当前为部分技术证据，未宣布完整技术验收。

每行链接到实际测试源码、候选适用检查及旧证据复用关系、独立评审与原票证据；索引不按票状态或用例数量自动判整条合同 PASS。完整字段见 `contract-evidence-index.json`。

| 合同 | 范围 | 当前证据范围 | 必需未完成项 |
| --- | --- | --- | --- |
| S1 | 平台与目标。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native, measurement |
| S2 | 公开上游。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| S3 | 共用执行。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native |
| S4 | 模型与认证默认值。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | paid |
| S5 | 工具环境。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| S6 | 本地最小形态。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| R1 | 授权落点。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| R2 | 所有权。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| R3 | 查看与执行分离。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| R4 | 退出与中止。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| R5 | 恢复核对。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| R6 | 执行版本。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| R7 | headless 与请求中断。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| T1 | 布局。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native |
| T2 | 状态与有界显示。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native |
| T3 | 当前任务和后续请求。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native |
| T4 | 队列冻结。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native |
| T5 | 历史与恢复。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native |
| T6 | 键位默认值。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native |
| T7 | 终端边界。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native |
| E1 | 原文。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| E2 | 有界与完整性。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| E3 | 身份和事实。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| E4 | 存储默认值。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| E5 | 故障。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| E6 | 用量和 trace。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| E7 | 自动与主动上下文压缩。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native |
| E8 | 压缩生效与取消。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native |
| E9 | 归档、清理、迁移。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| E10 | 查询与外发。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| V1 | 最小 eval。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | paid |
| V2 | 计划。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | paid |
| V3 | 独立试次。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| V4 | 正式隔离。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| V5 | 产物和评分。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| V6 | 预算与失败。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| V7 | 验证按影响选择。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| V8 | 效果规则。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| V9 | 报告与规则修订。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| I1 | 触发和受限分析。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| I2 | 候选合同。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | paid |
| I3 | 可改对象。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| I4 | 结构化选择。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native |
| I5 | 仅验证与准备。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| I6 | 抑制。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| I7 | 顺序、组合与失败。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native |
| I8 | 验证和启用。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| I9 | 回退与授权。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| I10 | 结果。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native, paid |
| M0 | 共同统计合同。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| M1 | 任务验收。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| M2 | 成本。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| M3 | 双时钟。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| M4 | 人工介入。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| M5 | 回归与返工。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| M6 | 故障。 | LOCAL_EVIDENCE_AND_REVIEW_AVAILABLE | 本地证据及评审可追查；无新增外部 gate |
| M7 | 反馈与报告。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | measurement |
| A1 | 真实路径。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | paid |
| A2 | 轻量与接受。 | PARTIAL_REQUIRED_OBSERVATIONS_PENDING | native, paid, measurement, daily_acceptance |
| A3 | 交付状态。 | PROCESS_BOUNDARIES_RECORDED_DELIVERY_INCOMPLETE | daily_acceptance |
| A4 | 实施顺序。 | PROCESS_BOUNDARIES_RECORDED_DELIVERY_INCOMPLETE | daily_acceptance |
| A5 | 工程阻塞。 | PROCESS_BOUNDARIES_RECORDED_DELIVERY_INCOMPLETE | 本地证据及评审可追查；无新增外部 gate |

ACC/MET 逐项通过 `contract_links` 指向以上行；缺少真实模型、native Terminal 或用户接受的条目继续保持 PARTIAL。
<!-- END IMMUTABLE R1 MARKDOWN -->

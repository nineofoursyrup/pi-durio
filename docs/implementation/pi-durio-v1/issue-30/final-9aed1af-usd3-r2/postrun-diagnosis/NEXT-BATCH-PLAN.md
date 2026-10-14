# #30 有界补充批次方案（未授权）

建议保持产品 `9aed1af6ee3b156bb7354961496217aa5e64843e`、固定案例/输入/初始文件/脏文件/允许范围/grader，以及每编码任务最多 8 次请求不变。保留原 `local-fix PASS`，新批次按顺序执行 **multi-file 一次、regression 一次、no-change 一次**；三项均 completed 且原 deterministic grader PASS 后，才做原 bounded `improve` 真实分析一次。实际候选仍另行呈现给人选择后才能写回。

这是一份具体方案，状态为 **PROPOSAL_ONLY_NOT_AUTHORIZED_NOT_MATERIALIZED**。没有生成新 grant、新 paid-start 或可执行新 harness。旧一次授权不能用于第二次启动。

## 证据与实现范围

- 原 r2 的 `STOPPED`、`multi-file error / grade unknown`、两项 not-run、所有 provider/journal/artifact 和第一次失败保持不变。旧 USD 3 首版冻结/expiry 审查失败也继续保留。
- 复用原准确候选、case/grader 的 `local-fix` outcome `e1:684:3452d528da95ff7f4aabe09522fa8bdbcefb3df57b71c8bafabe02094670a180` 与 grade `e1:687:d3f92c3c6db88c384d5220ce9c3267c4e48a6a802704f68469a8afabdb27c947`，作为新批次必须验证的依赖；不重复付费执行。
- 建议新 batch ID `pi-durio-v1-live-r2-usd3-supplement`，新外部目录 `.../issue-30/final-9aed1af-usd3-r3`，新 trial ID 为 `v1-live-r2-multi-file`、`v1-live-r2-regression`、`v1-live-r2-no-change`。新 multi-file 从原 fixture 新建，明确 `retryOf=v1-live-r1-multi-file`，不续跑原会话或继承原失败文件。
- 当前没有证据要求产品实现、公共接口或正式 runtime 规格变更。所需实现仅为外部补充 harness：固定三项 PASS 门、已有 PASS 的准确身份依赖、独立输出/计划/请求身份、新授权绑定和跨批次累计账本。
- 需要明确接受“补充批次”的验收协议。即使后续全部通过，也只能报告两批次合计四个不同案例均有 PASS 证据，同时保留一次执行失败；不能宣称原单次 4/4 PASS。原四条计划记录加新三条共七条；最多五次实际编码 trial，其中包含第一次 multi-file 失败。

## 新增与累计预算

| 项目 | 已发生 | 新批次最多 | 跨批次累计最多 |
|---|---:|---:|---:|
| 物理 provider 请求 | 15 | 32（eval 24 + improve 8） | 47 |
| tokens | 27,499 | 2,372,501 | 2,400,000 |
| 按 USD 1.20/M 的保守估算 | USD 0.0329988 | USD 2.8470012 | USD 2.88 |
| 美元授权总帽 | 计入累计 | 使用累计余量 | **USD 3** |

原 **40 requests 是已结束首批次的上限**。本方案新增最多 32 次、累计最多 47 次，是待明确批准的新请求范围，不能表述为“原 40 次上限不变”。所有 SDK retry / compaction 共享阶段额度，单编码任务 8 次仍不扩大。

已发生的 27,499 tokens 全属于 eval，故新 eval token 上限为 **1,172,501**，improve 保留完整 **1,200,000 / 8 requests**。eval / improve 单请求 reservation 继续为 **1,052,672 / 1,056,768**，max output 为 **4096 / 8192**。没有为套原 40 次上限截断 improve。

这些都是上限，不能保证走完全部阶段；reservation、时限或 token 额度不足仍须先停止。任何未知结算保留其 reservation 并计入累计，不可清账重试。保守公式沿用原冻结价格观察，启动前仍应验证适用性；它不是账户级硬消费上限或实付账单。若价格或边界无法满足 USD 3，停止并返回具体差异。

## 新启动的准备条件

1. 在独立新目录准备并冻结准确三例方案、improve request 与补充 harness，绑定原 PASS、原失败、累计15次/27,499 tokens 的账本及准确产品身份。
2. 对发生变化的三例 PASS 门、原证据不可覆盖、累计预算/unknown reservation、一启动重放拒绝、安装校验后的授权到期复核做针对性离线检查；auth-stop/cancellation 等不变且仍适用的既有证据明确复用。
3. 独立定向评审准确 manifest/harness，确认产品/source/build/install/case/grader 未变；目前没有可供授权的已冻结新 manifest。
4. 协调者取得绑定该准确 manifest 的 **新 one-start 明确授权**，写清新增 32 / 累计 47 请求、累计 USD 3、token 分配。建议新授权发出后24小时内仅启动一次，实际 `startedAt` 经安装检查后复核，活动时限为其后60分钟；旧授权或旧凭据就绪确认不替代新批准。
5. 新授权门通过后，才由协调者沿用固定安全 wrapper 读取凭据并执行。任一非 PASS、认证/预算/取消/时限问题即停止，保留结果及未运行阶段；不自动第三次尝试，不临时修改 prompt/模型/8次限制。

本轮仅完成只读诊断及方案文档；尚未准备补充实现、生成新 grant 或发起任何新 paid start。完整机器可读边界与来源见 [plan.json](plan.json)。

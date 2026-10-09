# #27 任务验收三率与双时钟

实现入口是 `pi-durio/metrics`。它读取原有 Evidence、独立任务受理和
控制队列；验收要求、固定结果、判断及撤销/争议也追加在同一 Evidence
存储。没有指标数据库、模型评分、后台追问或执行调度器。

## 查询

```sh
pi-durio metrics --data-root /path/to/data --scope '{"from":"2026-10-01T00:00:00Z","to":"2026-11-01T00:00:00Z","asOf":"2026-11-02T00:00:00Z"}' --format text
pi-durio metrics --data-root /path/to/data --scope '{"source":"synthetic"}' --format json
```

TUI 使用 `/metrics` 或 `/metrics JSON`，参数语义与 headless `--scope`
相同。`e` 查看来源，Enter 读取原文，`n/p` 原文分页，`r` 回看验收修订
之前的事实快照，`b` 返回。该面板没有 runtime/provider 句柄。现有
`/history`、`/compact`、`/eval`、`/improve` 与当前任务目标不变。

`source` 默认 `ordinary`，可显式选择 `synthetic` 或 `diagnostic`。
日常分母只取 coding；eval、improve、维护与未知来源/工作种类均列出
排除原因。未知任务类型和未知实际执行版本仍可留在默认 coding 样本；
筛选已知类型/版本时明确显示其排除原因。离线 transport 的真实本机
工具执行仍是 `synthetic` 来源，不代表真实模型或日常效果。

范围字段是 `from/to/asOf/project/taskType/version/source/through`，
另可用 `revisionOf` 指向此前导出的报告 ID。按受理时间 `[from,to)`
选样，随后按 `asOf` 的收到证据顺序前缀累计；`through` 固定取得序号。
时钟回拨不能使后收到的记录偷偷进入旧截止点。窗口内已受理但排队、
冻结、撤回、未启动的独立请求仍在 N；steer、真实重试和合法恢复不
新增任务。跟随请求的预期版本不冒充其实际执行版本。

报告同时给出 N/B/C/G/S、S/G、C/N、G/N、终止及缺失原因。G 不要求
属于 C，零分母是 N/A。报告 ID 绑定规则、范围、快照、原证据与查询
结果；`generatedAt` 是本次生成时间，不参与事实身份。`--destination
NEW_FILE` 可导出原报告，使用独占创建，不能覆盖旧报告；保存同一范围
的 `through` 可回看旧修订。证据后来缺失时不会伪造可复核性，旧导出
文件继续保留当时结果。

## 可选验收输入

```sh
pi-durio acceptance --data-root /path/to/data --spec /path/to/input.json
```

TUI 的 `/acceptance JSON` 和 `recordAcceptance(root, input)` 使用同一
追加接口。这是可选明确管理动作，不是结束必填项。普通交流中已有
明确结论可通过 `source.refs` 指向原消息/动作，复用其原句；不对自然
语言做额外模型分类。未核实提取、谢谢、采纳或模型自报用 `unverified`
来源，不能支持 PASS/FAIL。调用者不得把模糊消息标作明确人工判定。

每条输入包含稳定 `id`、`taskId`、`source`。`source` 包含
`kind: human|checks|unverified`、`actor`、`statement`、原 `e1:seq:sha`
来源 `refs`。`occurredAt` 可选，用来保留明确报称的发生时间；宿主同时
记录收到时间。省略时记录本次明确动作发生于宿主收到时。报称时间
没有单调时钟依据，不会被伪造成精确时长。

最小要求输入示例（ID/证据 ID 替换为实际对象）：

```json
{
  "type": "requirements",
  "id": "requirements-v1",
  "taskId": "TASK_ID",
  "source": {
    "kind": "human", "actor": "user",
    "statement": "result.txt 必须包含约定结果",
    "refs": ["ORIGINAL_REQUEST_EVIDENCE_ID"]
  },
  "ruleVersion": "result-check-v1",
  "necessary": [{
    "id": "result", "description": "result.txt 包含 ready",
    "check": {
      "command": "test \"$(cat result.txt)\" = ready",
      "passExitCodes": [0], "failExitCodes": [1]
    }
  }]
}
```

后续 `type: result` 声明 `requirementsId` 和不可变 `evidence` 引用。
`type: judgment` 声明同一 `requirementsId/resultId`、
`findings: [{requirementId, outcome: PASS|FAIL|unknown, evidence: [ID]}]`
及 `validity: valid|faulty|contaminated|insufficient`。

人工判断必须明确指向这些必要要求及结果。实际检查方式当前支持
固定 `shell-exit` 规则：要求在真实 shell 启动前保存，命令须完全匹配，
检查属于该任务且引用在固定结果内，宿主观察到完整、已结束的结果，
退出码须属于预定 PASS/FAIL 集。只有这些条件下才采用真实检查结果，
不会信任输入自称 PASS。检查命令及覆盖面由可信宿主/用户声明；它不
自动证明命令未检查的需求，也不把任意非零退出泛化为验收 FAIL。
宿主可在 `task.accepted` 的 observation 回调中预先保存要求；此路径
已用公开 runtime 验证。验收输入只写短 SQLite 事务，不接管执行 owner。

宿主在写入 judgment 时生成 `assessment`，保留规则版本、方法版本、
必要要求/结果来源、所用检查/人工来源引用及原始输入 `submitted`。
用户传入同名 assessment 不受信任。查看报告只投影这份保存的判断，
并核对内容是否仍可取得；不重跑 shell、调用模型或新建判断。
保存的依赖包含实际采用的 shell.started/end、要求/结果及其原来源。
缺失或损坏的验收原件按原 admission run 保守降为 unknown，保留原
引用与精确 task 归属未知；其他 admission run 的完好任务仍可查看。
PASS 需要全部必要要求覆盖；一项可靠必要失败足以 FAIL。缺失、故障、
污染或不足保持 unknown。

要求/结果修订使用 `revisionOf` 和 `reason`；判断纠正使用 `supersedes`
和 `reason`。`type: withdraw|dispute` 带 `targets: [ID]`、`reason` 和明确
来源。撤销新记录不会自动复活已被替代的旧记录。分叉修订或事实有效性
争议保持 unknown；尚未解决的 PASS/FAIL 冲突中，可靠必要失败保留为
FAIL，原冲突仍显示。后续返工记录本身不会撤销已有验收。

## 双时钟

执行时钟从真实受理点到宿主确认的执行终止（包括未启动撤回）；
unknown/resumable、冻结或恢复核对不是终止。验收时钟从受理到所选
最终结果/规则下第一个仍有效的确定判断。先 FAIL 后 PASS 不延长为
“终于通过”；未被撤销的先 PASS 后可靠 FAIL，则当前结论为 FAIL，
首个判断时间与其 PASS 分类仍分别保留。

同一随机进程实例的单调时间给出精确差值；跨进程或旧记录缺少单调
端点时，只保留标明未核实的墙钟估算。回拨不会伪造精确总值。分段
列队列、用户等待、模型/工具可测活跃、恢复/离线与未知。可测子过程
取区间并集，冲突的排他阶段进入未知，不简单相加。可选可信宿主
`task.phase {id,phase: user-wait|recovery-offline,action: start|end}` 是明确
阶段端点；不存在这类事实时不从消息、steer 或没有输出猜测用户等待。

报告保留每段原始来源与端点。只有完整可测的已结束时长进入均值和
nearest-rank 分位数；open waiting、缺端点、不可比较时钟都列 valid/
missing/pending，已知局部不冒充完整总量。终止范围为受控产品执行，
原本未知的远端或外部进程结果继续未知。首个宿主判断优先按同进程
单调时钟选择；跨进程仅保留取得顺序，报称发生时间仅保留墙钟估计，
判断发生时间不可互比时明确列 unverified，验收精确时长不计入均值。

## 给 #28/#29 的只读接口

```ts
import {queryTaskMetrics, type MetricsScope} from 'pi-durio/metrics';
const report = queryTaskMetrics(dataRoot, scope);
```

稳定 `pi-durio-task-metrics-v1` 输出包括：

- `scope.through/asOf/from/to/source`、`snapshot`、`excluded/duplicates`；
- `tasks[].taskId/requestId/runId/evidenceRunId/project`、受理与真正开始/终止
  原记录、实际 `version` 和另列的 `expectedVersion`；
- `tasks[].acceptance.outcome/firstValid/history/judgments/requirements/results`；
  S 取同一批 `outcome === PASS`，不得另找有利历史判断；
- `tasks[].clocks` 原时间与分段，以及 `counts/rates/clocks` 汇总。

本票不计算成功任务成本、人工介入、7 天返工或运行故障率；下游可据
上述成员及 judgment 来源使用相同分母。这里不把离线算术、组件检查
或真实工具执行混同为付费模型、原生 Terminal 或最终日用接受。

## 验证入口

`npm run check`；重点行为测试在 `test/metrics*.test.ts` 和
`test/fact-clock.test.ts`。已知事实夹具独立复核 10/8/6/5/4、12 分钟与
24 小时、修订/争议/撤销、回拨/恢复/重叠/缺端点。真实离线 runtime
测试另行运行真实文件写入与 shell 检查，并核对 CLI/TUI/重开/导出
不增加请求、不修改 host 数据库。最终安装候选与命令证据在本票
handoff 指定的外部 evidence 目录中。

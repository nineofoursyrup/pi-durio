# #29 人工介入与交付后返工

`queryFeedbackMetrics(dataRoot, scope)` / `formatFeedbackMetrics(report)` 从同一个
既有 journal 只读聚合；CLI、TUI 和导出使用同一份机器报告。

```sh
pi-durio feedback-report --data-root /path/to/data --scope '{"from":"2026-10-01T00:00:00Z","to":"2026-11-01T00:00:00Z","asOf":"2026-11-08T00:00:00Z"}' --format text
pi-durio feedback-report --data-root /path/to/data --scope '{"source":"synthetic"}' --destination NEW_FILE
```

TUI `/metrics [JSON]` 中按 `f` 切换反馈，`o` 切换成本/故障，`e`/Enter
查看来源，`r` 查看旧修订，`n/p` 分页。导出独占创建新文件，不覆盖旧报告。
保留原报告的 `scope.asOf/through` 可以重现收到证据的同一前缀；
`generatedAt` 表示本次渲染，`id` 绑定范围、规则和来源。默认只统计 ordinary
coding；synthetic/diagnostic 需显式选择，eval/improve/maintenance 分开。

## 两个不同母群

- `intervention` 按受理时间 `[from,to)` 选任务。实际开始至第一次交付或真正终止
  为观察阶段，包含同任务暂停和恢复。已结束 `Ni=I+Z+U`；显示 `I/Ni`、
  `(I+Z)/Ni`、事件次数、未开始与未结束阳性。多次救场只增加事件数。
- `rework` 独立按首次实际交付 `[from,to)` 选任务。窗口前受理但窗口内交付也入样。
  从最早可读的 `run.closed/recovery.closed` 中，取宿主 `completed`、
  `cleanup=confirmed` 且保留非空结论的首次事实。中间模型自报、patch、失败诊断
  和验收 `firstValid` 均不建立窗口；未验收交付、分析结论也可入样。
- 返工窗口固定为 `[firstDelivery,firstDelivery+7*24h)`，再次交付单列且不重置。
  满七天的成熟组 `Nr=Rr+Zr+Ur`；报告 `Rr/Nr`、覆盖、未知与逻辑范围。
  未成熟及其阳性单列；成熟但没有充分反馈仍为未知。零分母为 N/A。
- 阳性要求明确原要求未满足且纠正已被要求/开始/完成；仅投诉不算。
  正常授权、澄清、improve 选择、新需求与原要求救场分开；交付前纠正、
  窗外事实、未知发生时间、未来于查询截止点的声明各自可查，不丢弃。
- 阴性必须有明确人工反馈覆盖全阶段/全窗口。日志完整、PASS、没有投诉、
  steer 次数和文件修改本身都不足以证明阴性。未知时间的可靠纠正不能被阴性遮盖。

发生时间使用保留的宿主交付时间与反馈明确声明的 `occurredAt`；取得时间使用
不可改写的 journal receipt。迟报在实际发生的窗口中产生新报告，历史快照保持原值。
报告不把墙钟时间称为单调时长，不把时间/来源缺口当成精确观测。

## 复用已有明确反馈

普通运行不增加评价、弹窗、追问或模型分类。已有交流/动作可直接引用其
`e1:sequence:sha256` 原文，明确的原句和作用对象由可信宿主或使用者声明。
不能明确解释的内容用 `meaning: "unknown"` 或 `source.kind: "unverified"` 保留。
没有通用自然语言分类器，不从一句“通过”推断其他判断维度。

`recordFeedback(root, input)` 和以下可选命令是同一追加入口，不是另一套账本，
也不注册为模型可调用工具。正常任务结束不依赖这个入口。

```sh
pi-durio feedback --data-root /path/to/data --spec feedback.json
```

```json
{
  "type": "observation",
  "id": "stable-original-feedback-id",
  "taskId": "ORIGINAL_TASK_ID",
  "dimension": "rework",
  "meaning": "correction",
  "source": {
    "kind": "human",
    "actor": "user",
    "statement": "原请求要求 ready，但交付内容是 broken；请按原要求修正。",
    "refs": ["ORIGINAL_MESSAGE_REFERENCE"]
  },
  "requirements": ["ORIGINAL_ADMISSION_OR_REQUIREMENTS_REFERENCE"],
  "delivery": "FIRST_NORMAL_CLOSE_REFERENCE",
  "occurredAt": "2026-10-10T10:00:00Z",
  "originalRequirement": "unmet",
  "correction": "requested"
}
```

`dimension` 为 intervention/rework；`meaning` 为 correction、none、
normal-authorization、clarification、new-requirement、improve-choice、complaint、unknown。
发生时间无法可靠确定时填写 `null`，不默认填取得时刻。阴性用 `meaning: "none"`
并提供明确声明的 `coverage: {from,to}` 和声明发生时刻；提前声明不能覆盖未来。
`requirements` 必须引用本任务的受理原请求或 `acceptance.requirements` 原文，
不允许任意其他任务/消息冒充原要求。`source.kind: "action"` 必须附可读原动作。

`repairTaskId`、`repairSources`、`resultSources` 可关联实际独立返修和结果；
修复完成/是否有效只能按实际原证据声明，修复任务保留自身受理、版本与费用身份。
报告同时保留原任务执行版本、要求/结果/反馈修订，不推断某个模型造成缺陷。
人工救场和运行故障可以同时成立。

纠正原标记使用新 id、`revisionOf` 和 `reason`；撤销使用
`{type:"withdraw",id,taskId,source,targets:["PRIOR_ID"],reason}`。
旧事实不覆盖，撤销替代判断不复活其已废止前任；修订分叉为未知，不挑有利分类。
相同稳定 id 的相同输入只返回原 receipt；带原文 refs 的相同反馈以新 id 重复接收也去重。
直接补记原句且没有 refs 时，由调用方沿用稳定 id 区分重复投递与真实重复事件。
原反馈/撤销原文缺失时保留已观察事实及来源缺口，当前确定统计降为未知。

## 验证与边界

`test/metrics-feedback.test.ts` 复核已确认例 4/5、七天边界、独立交付母群、
未验收交付、迟报、未成熟阳性、修订/撤销、去重和来源缺口。
`test/metrics-feedback-runtime.test.ts` 使用公开 runtime 实际交付错误文件，再进行
独立修复与 shell 核对，验证 CLI/TUI/导出不增加模型请求或改写 journal。
`acceptance-demo.mjs` 在独立 npm 安装上运行同一纵向路径，并保留真实 execution
artifact 与 package/source-build 身份。所有 transport 与用户反馈角色均为明确
synthetic 测试，不代表真实模型质量或真人日用判断。

本票提供本地组件与 headless 验证。真实付费 DeepSeek 属 #30，完整 native Terminal
组合与技术测量属 #31，明确人类日用接受属 #32；不把这些状态写成已完成。

# #28 全样本成本与任务、尝试故障

`pi-durio/metrics` 的 `queryOperationsMetrics(dataRoot, scope)` 复用 #27 的
`queryTaskMetrics`、当前有效 `S`、受理成员、`through` 和 `asOf`。报告只读，
没有模型分类、后台追问、额外账本或执行调度。

```sh
pi-durio operations --data-root /path/to/data --scope '{"source":"synthetic"}' --format text
pi-durio operations --data-root /path/to/data --scope '{"from":"2026-10-01T00:00:00Z","to":"2026-11-01T00:00:00Z","asOf":"2026-11-02T00:00:00Z"}' --destination NEW_FILE
```

TUI `/metrics [JSON]` 内按 `o` 切换成本/故障，`e` 选来源，Enter 看原文，
`n/p` 分页，`r` 看旧修订。CLI、TUI、包接口和导出都调用同一查询。
`scope` 与 #27 相同；日常默认 ordinary coding，synthetic/diagnostic 明确选择。
导出独占创建新文件，不覆盖旧报告；保存报告中的 scope 可重现原快照。

## 成本

- `costs.sample`：受理窗口中全部 coding 任务截至同一快照的关联成本，
  除以当前有效 PASS 数 `S`。失败、取消、重试、自动压缩均保留；不是仅成功项费用。
- `costs.period`：请求在 `[from,to)` 实际发起的全种类费用，独立列示，不除以样本 S。
- `costs.requests`：原始 request identity、usage、币种、价格来源、版本、有效时间、
  历次估算、缺口及归属。手动压缩即使复用原 run/session 也属于 maintenance。
- `sessionUsage` / `sessionEstimates` 保留既有 `queryUsage` 累计投影和 `usage.estimate`
  原文，仅供核对，不再与每请求费用相加，也不用累计差值伪造归属。
- `evalStages` 和 `parentImprove` 是同一组原始请求的分类/归属视图。
  正式 eval 使用可信外层 `provider.dispatch`/`budget.settle`/原始 bytes，
  不从 guest 声称的模型尝试另计费用。未记录的人力、机器折旧不在费用内。

`state` 为 complete/partial/unknown。缺 usage、在途、旧价格缺有效时间、
归属不明或价格分叉均阻止完整成本结论；`knownPartPerSuccess` 明确不是最终值
或未经证明的下界。`S=0` 时 `perSuccessState=N/A`，开销和缺口仍显示。
跨币种分开报告，没有隐式汇率转换。所有金额都是估算，不是实付账单。

### 显式追加价格估算

已有 Pi catalog 金额缺少历史生效日期时保留该缺口，不补造日期。需要重新估价时：

```sh
pi-durio cost-estimate --data-root /path/to/data --spec estimate.json
```

```json
{
  "id": "tariff-reestimate-1",
  "requestSource": "e1:REQUEST_SEQUENCE:REQUEST_BODY_SHA",
  "amount": 0.012,
  "currency": "CNY",
  "price": {
    "source": "declared tariff document or explicit estimate basis",
    "version": "tariff-v1",
    "effectiveAt": "2026-10-01T00:00:00Z",
    "provider": "deepseek",
    "model": "deepseek-flash"
  },
  "usageSources": ["e1:RESPONSE_SEQUENCE:RESPONSE_BODY_SHA"],
  "reason": "Explicit calculation using the cited acquired usage and tariff"
}
```

`recordCostEstimate(root, input)` 是对应包接口。它核对可读原 request/usage、
provider/model、时间及修订身份；金额由显式可信宿主/用户声明的计价依据提供，
不声称外部价格已自动核实。该入口不注册为模型工具。后续修订填写
`revisionOf` 和新 id/理由，保留原值；并行分叉保持冲突，不能自动挑有利价格。
模型响应 usage 未报告时不能用该接口把缺失用量补成零。

## 故障

任务层始终 `B=F+Zf+Uf`：已观察到故障即 F；完整观察且真正终止、无故障为 Zf；
其余无已知故障为 Uf。输出 F/B、故障终止/B、覆盖 `(F+Zf)/B` 和逻辑范围；
该范围不是置信区间。取消前的故障仍属于 F，多次故障按任务去重、事件另列。

实际 model/tool dispatch 分开计算 error/normal/cancelled/planned-stop/open/unknown。
预传输拒绝与未证明 dispatch 单列，不加入已发起分母；SDK 内不可见重试不猜。
按预先声明 shell-exit 规则得到的业务非零属于正常工具结果；没有目的依据的
`isError`/非零保留 unknown，不自动当运行故障。正常受管取消和输出上限停止
属于结果已知覆盖；远端/外部效果原本未知仍未知。停止失败可以形成执行故障。

恢复只在同一 durable 操作身份的后续正常结果有证据时确认；同 run 中无关工具成功
不足以证明恢复。故障终止需终止原因与原故障有来源对应，或匹配当前宿主保存的
非 done submission + 最终模型错误映射；历史有故障且最终 failed 不足以推定因果。
缺乏对应时列 `faultTermination=unknown`。grader、派生观测和执行故障分别保留。

## improve 子 eval

只沿 #24 `improve.eval` 的明确 scoped `planSource`，核对父 decision、group/check
声明的临时路径和子固定计划。报告使用父 `improve.check.reportDocument` 保存的
子 `asOf`，再受本次同一 `asOf` 限制；父 `through` 不当作子序号。没有父检查快照时
只读固定 plan 并标未知。子根缺失、路径被改、旧裸引用或源失效均列 gap；不扫描
其他目录，不执行计划，不把子 eval 记成另一份 coding/improve 费用。TUI 子来源读取
显式所属根。用户直接查询子根可查看其更新后的独立报告。

## 验证边界

`test/metrics-operations*.test.ts` 复核 ¥80/S4=¥20、期间 ¥118、2/8 故障例，
以及缺失、S0、跨窗、跨币种、取消、价格修订、手动维护和父子快照。
`acceptance-demo.mjs` 只通过独立安装的公开包运行实际本地 Harness/工具和明确
离线 transport，保存 CLI/TUI/导出只读、实际费用归属及故障原件证据。
这些是真实本地受控执行，来源仍为 synthetic；不冒充真实模型质量、账单或日用效果。
付费 DeepSeek 属 #30，完整 native Terminal/测量属 #31，人类日用接受属 #32。

# #22：fresh 配对与限定范围的改善判定

`eval plan` 可固定 `comparison`，由既有顺序 runner 在 Apple container VM 中 fresh 执行 baseline/candidate。两侧使用同一案例初态、独立产品 session/目录和相等的 trial 限额。TUI `/eval` 与 `eval report` 共用只读查询，不产生执行、评分或费用。

## 固定计划

在 #21 的 JSON 计划选项中加入以下对象；`installation` 指向按固定镜像准备的 Linux 产品目录。两侧也可各自声明 `installation`，把不同 build 的完整可取得内容固定到已有 Evidence store。`instructions` 是明确的两侧行为差异，内容连同 runtime 和模型配置构成 trial 的执行版本；它在同一产品入口执行，没有另建 agent loop。

```json
{
  "comparison": {
    "kind": "deterministic",
    "repetitions": 2,
    "repetitionBasis": "固定脚本重复两次，覆盖 AB/BA；不证明随机模型稳定性",
    "change": "说明此组合的全部变更",
    "hypothesis": "说明预期怎样影响主要目标",
    "roles": { "local-fix": "objective", "regression": "protection" },
    "objective": {
      "metric": "requests", "direction": "lower", "delta": 1,
      "basis": "此受控脚本中一个完整宿主 dispatch 是最小有意义差异"
    },
    "protections": [
      { "id": "scope", "kind": "hard", "check": "scope", "cases": ["local-fix", "regression"] },
      { "id": "tokens", "kind": "soft", "metric": "tokens", "direction": "lower", "tolerance": 0,
        "basis": "固定脚本用量完全确定，要求不增加", "cases": ["local-fix", "regression"] }
    ],
    "trialBudget": { "maxRequests": 6, "maxTokens": 6144 },
    "sides": {
      "baseline": { "instructions": "" },
      "candidate": { "instructions": "Keep the final response concise while satisfying every requirement." }
    }
  }
}
```

上述示例使用两个案例、两次重复，共 8 个 trial，因此整批 `budget.maxRequests` 至少 48、`maxTokens` 至少 49152。单请求上界、trial/评分超时、绝对 deadline、价格及 paid 授权仍由 #21 的字段固定。前侧用尽本 trial 配额，不借用后侧额度；整批上限或 deadline 触发时，后侧可能未执行，保留为不完整，绝不延期或重置额度。试次按案例及重复排列，配对先后依次 AB、BA；显式传入的 `trials` 必须匹配这一固定顺序。内部请求重试仍为 0。

`roles` 必须覆盖计划中的全部案例，至少一个主目标案例；仅保护案例不要求产生收益。主要指标只允许一个：宿主 dispatch 数 `requests`、宿主记录的 `tokens`、按固定价格估计的 `cost`、可信宿主阶段耗时 `taskMs`，或任务达标 `task-pass`。`taskMs` 包含 VM/runtime 开销，不冒充纯模型活跃时间。`delta: null`、缺少门槛依据、仅一次随机 trial 可用于诊断，但不能判正式改善或无明显差异。没有收费价格时可显式用 `price: null`，费用保留 unknown，效果证据不足。

默认 `scope` 和 `task` 是独立评分结果。必要时在固定 grader 中增加 `observations: [{name, path, expected}]`，由宿主对可信 grader 的 JSON 输出分别检查。例如输出 `[5,1,0]` 的 `path: [1], expected: 1` 可独立保护有符号加法；整体任务失败不会抹去这一项的通过。规则内容和 expected 留在可信宿主，候选依旧只在受限环境执行。增加观察项时，grader 的 `expectedStdout` 必须为 JSON。

## 判定与分母

先报告有效证据证明的新增硬回归，即使其他 trial 尚未运行；污染数据不可归因。然后在全部必要比较完成且有效时，检查主目标是否逐对越过负阈值，或某个软保护项在对应案例的所有重复中一致越过容忍度。其余情况下，只有全部计划有效完成、候选硬约束和保护项通过、所有计量/价格/模型返回身份完整可比，才检查每个目标配对的 `d ≥ δ`（改善）或 `−δ < d < δ`（无明显差异）。相反方向的重复、部分通过或平均值不能代替逐对规则。

两侧失败不能靠较低的成本、时间或请求数获得效率改善。新失败无法归因为 candidate 新增时，保留任务不达标与证据不足。未归属费用、unknown usage、未证实 dispatch、缺价、实际用量超出固定可信上界和不同模型返回身份均可追查；返回 alias 不证明不可变模型权重。

保护统计按要求 × 案例 × 重复配对：P 为计划保护配对，V 为两侧该项证据有效且 baseline 通过的配对，R 为 candidate 新失败。报告 `R/V` 与 `V/P`、原值及每项排除原因。baseline 整体失败但该保护项通过仍计入 V；硬回归不被低总体率抵消。零分母显示 N/A。日常返工与本报告分开。

## 查询与独立规则修订

```sh
pi-durio eval report --data-root DATA --id PLAN --format text
pi-durio eval report --data-root DATA --id PLAN --snapshot SEQ
pi-durio eval grade --data-root DATA --id PLAN --spec REVISION.json --directory NEW_DIRECTORY
```

机器报告给出 `asOf` 序号。TUI 输入 `r` 在当前报告与历史评分修订前的快照间切换，`e` 查看来源；这些查询均只读。重评分对象仅是相同的固定 outcome；新 grader 对受影响案例的所有两侧试次一致应用，保存旧完整报告并标注受影响规则。若仅一侧完成新评分，当前比较不会回退混用旧规则。修改规则内容必须使用新版本身份。改变任务、初态、环境、候选行为或补跑则新建计划，不能复用旧 outcome 证明新执行效果。

纯文案/加载一致性、确定性回归或明确资源基准按所改影响选择现有检查；仍可使用 #21 非 comparison 计划直接检查。模型策略或成本/延迟变化需要 fresh 对照。本票不要求每次改动都运行全量模型 A/B。

## 可重现的实际执行验收

```sh
node scripts/eval/compare-demo.mjs INSTALLED_PRODUCT LINUX_RUNTIME NEW_EVIDENCE_DIRECTORY
```

脚本固定两个案例、各两次 baseline/candidate，fresh 运行安装产品，共 8 个新 trial。它使用现有可控 provider，独立 oracle 是请求数无明显差异；两侧全部真实产物经独立受限 grader 检查。随后故意改变一项评分 expected，以已知错误 oracle 追加规则修订：两侧同样 FAIL、效果证据不足，原 outcome 和先前结论保留，provider 请求不增加。该修订用于验证评分接线，不是产品退化证据。

实际运行记录、候选源码/编译/包/独立安装身份、已知结果的四结论材料和首轮失败位于 `/Users/nineofour/pi-durio-v1-run/evidence/issue-22`。准确检查与证据索引见交付时的 `handoff.json`。这些确定性材料证明执行、计量与规则接线；付费 DeepSeek 能力/随机收益为 #30，完整原生 Terminal 组合验收为 #31，日用接受为 #32，本票没有替代这些门槛。

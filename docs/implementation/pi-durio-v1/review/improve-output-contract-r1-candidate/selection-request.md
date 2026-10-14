# 实际 R1 候选选择请求

推荐选择“执行已声明范围”：在既有受限 VM 中运行一次原保护回归，仅全部通过后写回指定 fixture 的 `clamp.ts`。不新增模型调用，尚未做此选择或执行。

本轮真实分析生成1个canonical候选。原summary开头自相矛盾，hypotheses[1]还误称旧区间内和超上界案例已通过；实际旧表达式在lower≤upper时等于min(lower,value)，(6,0,10)和(14,0,10)均为0。原报告和revision完整保留，[静态说明](STATIC-ANALYSIS.md)披露该错误。下述补丁可供选择，尚无实际回归PASS或效果结论。

## 精确对象与补丁

- Report `v1-live-r4-improve` / revision `b8e9b7c7c08d06d5ed955339630fac5e1b8fe59e6e700acd6499863d932aad2a`。
- Candidate `candidate:197afe0a113c5c58ad0810ca24a4ad98`（显示R1）/ revision `49e9331f282cda12efe5fb89f4b6ef35b8e50a8dc2d8140fa48c5fe3824c91c8`。
- Target `/Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af/improve-project`，只允许 `clamp.ts`。
- Baseline `46864e756634ac28260fe43119d15103008ce1a2fbc9b37b548c2b2027ab257f`；applicableVersion `c3a26d10711de3ae1afdd08698e4dd43a92f48d1bc591653e8778218aa373ffd`。
- [冻结执行计划](../../issue-30/improve-output-contract-r1/candidate-execution-plan-r1/README.md) manifest SHA256 `686b5c023020444104cd711b809dfd01442b0568a79fa36e42484716c8f1f3fe`。

```diff
-export const clamp = (value: number, lower: number, upper: number) => Math.min(upper, Math.min(lower, value));
+export const clamp = (value: number, lower: number, upper: number) => Math.min(upper, Math.max(lower, value));
```

输入SHA256 `b33b7f38ce6fa4d07899ebd5494dd7d800d2b554752b25ed7645d9b0827bd4fc`，拟写111字节SHA256 `45e016afe980df19159fc0679a6e44d88838a7a5afc398820309b576884f003c`。签名与其他字节不变；`check.mjs`、`README.md`、`package.json`按冻结原hash保护，没有其他候选、依赖或冲突。

## 一次选择包含的动作

1. 用户明确选择后，绑定上方report/candidate/revision/baseline/manifest，记录实际用户答复和来源；24小时内最多启动一次，启动时固定5分钟总deadline。
2. 将已关闭且完整hash绑定的原分析记录复制到独立 `decision-data`，原件和原report不变；global cutoff=4298，继承的4次调用属于已有累计45次，不重新计费。准备阶段尚无该副本或validation-work。
3. 经已安装产品公开 `previewImproveDecision` / `submitImproveDecision` 入口提交 `execute-declared-scope`。只在临时副本应用上述固定补丁，复用已有受限VM执行原 `node check.mjs`，核对baseline、完整四文件集合、保护字节及退出结果。
4. `maxChecks=1`，check timeout=30秒、原check子进程10秒；`maxRequests=0`、`maxTokens=0`、新增provider费用=0。全部通过且正式目标仍等于原baseline才写回同一111字节，随后只读重开报告和决定、核对精确产物与记录。
5. 失败、取消、超时、UNKNOWN、记录失败或内容漂移即停止；保留首次结果，不自动重试、延长、重新分析、补偿或回退。无配置启用、额外正式文件修改或产品构建。

选择模式 `execute-declared-scope`，formal.writeback=true，activate=null，failureCompensation=none。该确定性修复采用原直接回归，无模型A/B或性能改善主张。累计保守占额仍USD1.4248548（45requests、130611known+1056768旧UNKNOWN预留），非账户账单；原raw952不回填UNKNOWN。

旧111字节保存在原对象库；如以后需要回退，须再明确选择并确认当前字节仍是本次写入，避免覆盖后续编辑。执行授权不包含自动回退或新的产品发布。

## 需要用户选择及原因

- **选择 R1，验证通过后仅写回 clamp.ts**：同意上面的精确范围、唯一一次检查/条件写回、0新provider、时间与失败条件，并知悉原报告的推理错误。
- **暂缓 R1**：本轮不执行候选。

此前直接批准的是一次真实分析，已消费；该批次明确排除选择/验证/写回。已确认总规格I4要求“默认不选”“汇总目标、依赖、冲突、顺序、验证及总预算后一次明确提交”，I2规定“候选文本本身不授权”。因此这里需要实际候选选择，不是重复申请付费分析。见[总规格](../../../../specs/pi-durio-v1-spec.md)。这不是技能额外审批要求。

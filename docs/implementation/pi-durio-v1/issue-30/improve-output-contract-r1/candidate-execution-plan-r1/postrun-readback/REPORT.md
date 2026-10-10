# R1 唯一实际执行回读：#30 真实 improve 链已观察成立

直接人类选择“选择 R1，验证通过后仅写回 clamp.ts”绑定冻结计划 `686b5c023020444104cd711b809dfd01442b0568a79fa36e42484716c8f1f3fe`。本次唯一执行于 `2026-10-10T10:45:25.690Z` 开始、`10:45:29.192Z` 完成，退出 0，状态 `COMPLETED_EXACT_PROJECT_WRITEBACK`。授权已消耗。

现有真实分析报告 → 实际人类选择 → 公共 decision → 保护验证 → 精确写回 → 只读重开，这条 #30 链路现已观察成立。原四类 coding 任务的既有 PASS、原 first failures 和执行身份沿用既有适用性证据，没有重跑或替换。

| 环节 | 本次保留证据 |
| --- | --- |
| 实际选择 | `actual-selection.json`，SHA `48a40d980bed8f81ccbc9c06888e432bffdce084bcf3320150c58a4bd507317e`；原话、call ID、时间均保留 |
| 公共 decision | `v1-live-r4-clamp-execute-r1`；`e1:4299:12d8398e46913fe3f079f99a5a408aef165247664c5c84376acce2b8e69ac490` |
| 保护回归 | 1 个 regression，原 check 六例通过，退出 0，原 stdout `All declared clamp requirements pass\n` 共 37 bytes；固定 program/构造文件哈希相符 |
| 终止 | VM `terminated:true`，保留 stopped/delete/absence 控制回执；本次回读未运行新的控制命令 |
| 正式写回 | validation seq 4307 → formal-started 4308 → write-intent 4309 → write-result 4310 → formal 4311；仅 clamp.ts |
| 重开 | submitted 与 reopened decision 字节相同；canonical report 与原分析完全相同；activation `not-enabled` |

实际候选仍为 `candidate:197afe0a113c5c58ad0810ca24a4ad98` / revision `49e9331f282cda12efe5fb89f4b6ef35b8e50a8dc2d8140fa48c5fe3824c91c8`，报告 revision `b8e9b7c7c08d06d5ed955339630fac5e1b8fe59e6e700acd6499863d932aad2a`。历史分析中的 `not-started/unselected/unverified` 字段作为原报告保留，实际执行事实通过新增 decision 链表达，不改写原报告。

正式 clamp.ts 为已验证的 111 bytes，after SHA `45e016afe980df19159fc0679a6e44d88838a7a5afc398820309b576884f003c`；README.md、check.mjs、package.json 三个受保护文件与原哈希相同。原 before SHA `b33b7f38ce6fa4d07899ebd5494dd7d800d2b554752b25ed7645d9b0827bd4fc` 的对象仍保留。

关闭原分析树的 3,427 个文件逐一匹配冻结 seed。clone 的 seq <= 4298 与原 SQLite 逻辑记录完全相同，新增仅 seq 4299–4312 共 14 条；没有新增 provider/budget/model.dispatch。继承的 4 条 provider.dispatch 已属于累计 45 次，未重复计费。累计仍为 known 130,611 + 旧 UNKNOWN 1,056,768 = 上界 1,187,379 tokens / USD 1.4248548；没有账户账单主张。

旧 15,558 项 preflight 清单保留为历史 before，未重扫或改写。其中活目标 clamp.ts 现按明确授权发生唯一 after 变化，不把该预期变化称为证据漂移。冻结计划 30 个输入身份仍相同；本次回读的全部输入前后身份一致。大型原树/SQLite/原始完整重开结果仍留外部证据，索引按哈希引用；本目录只镜像必要选择、执行、写回与 VM 回执。

效果为 `direct-checks-passed`；`allDeclaredBenefitsMet:false`，没有性能、模型质量或单项因果改善主张。原模型摘要/假设错误、旧 UNKNOWN 和 first failures 全部保留。这次 #30 链路观察不代替 #31 全技术结论、#32 日用接受、产品 main merge/release 或 Issue close。

本归档仅使用只读 JSON、SQLite `mode=ro&immutable=1`、对象及文件哈希；没有导入产品 API，没有重跑 VM/check/provider，没有更改 fixture、原件、root/state 或远端。未复跑已失效的“尚未授权”旧 verify-plan。

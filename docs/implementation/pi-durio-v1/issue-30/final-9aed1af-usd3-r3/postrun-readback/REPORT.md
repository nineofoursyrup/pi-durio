# r3 补充批次只读结果报告

本轮状态为 **STOPPED_NO_EXECUTABLE_CHAIN**：三项补充 coding trial 全部 PASS；真实 `improve` 因产品缺陷 **LIVE-USD3-R3-01** 在首个响应后停止，产生 **0 个候选**。未进行候选选择、候选验证、激活或写回。完整机器报告见 `report.json`，诊断见 `IMPROVE-FAILURE.md`。

- 产品：`9aed1af6ee3b156bb7354961496217aa5e64843e`；frozen manifest：`07ed36fdeb17f24d7e8d6caea0db4efd41dd31111fa7ef6ea4cb0a51daa0251e`。
- 唯一已记录启动：`2026-10-10T06:38:46.776Z`；结束：`2026-10-10T06:41:35.851Z`；没有追加启动。
- 当前 report：`v1-live-r2-improve` / revision `cc9cbac2720484f05b11666fc06621f9be03fbc40a90ed1d48924397493f19b6`。重新打开的 report 与原 report 完全一致；run result 仅增加持久化 `clock` 元数据。
- cleanup `confirmed`、storage `closed`；`remoteTermination` 仍是 `unknown`，不提升为已证明远端停止。

## Coding 结果与原始失败

| Trial | Host 物理请求 | 已知 tokens | 原始 outcome / grade |
| --- | ---: | ---: | --- |
| r2 `local-fix`（复用） | 7 | 13,370 | completed / PASS |
| r2 `multi-file`（首失败保留） | 8 | 14,129 | error / unknown |
| r3 `v1-live-r2-multi-file` | 8 | 15,574 | completed / PASS |
| r3 `v1-live-r2-regression` | 7 | 15,142 | completed / PASS |
| r3 `v1-live-r2-no-change` | 3 | 3,345 | completed / PASS |

新三项的 scope 与 task 检查均为 true，调用原固定输入与 grader，正式单任务 8 次限制未变。三项 artifact、outcome、grade 与 guest journal 均读取并核对。r2 未运行的 regression/no-change 保留原 `not-run`；r3 新 trial 不覆盖它们。现在四类场景都有 PASS 证据，分属两次执行；不能把原 r2 批次改记成 4/4 PASS，也不能抹去旧 multi-file error / unknown。

## 真实 `improve` 的停止点

首个 host 请求收到 HTTP 200；最后 raw SSE chunk 含 `prompt_tokens=923`、`completion_tokens=29`、`total_tokens=952`、`finish_reason=tool_calls` 与 `[DONE]`。SDK 给出完整 `toolUse` 响应，`evidence_summary` 也正常完成。

产品已保存并解析上述用量，但在 SDK 正常消费 `[DONE]` 后取消 reader 时，把 host settlement 写为 `tokens:null / cancelled / reason:undefined`。第二次 generation 的预算入口于是抛出 `BUDGET_UNKNOWN_USAGE`，记录 `dispatched=false`，没有第二次物理请求。SDK 显示的 `Connection error` 是该本地拒绝的表面错误，不足以判成网络故障。

该缺陷影响 #23 的真实 improve 路径，由 #30 发现。过去独立 offline review/PASS 的候选、时间和适用范围保留；修复、受影响复核和新候选验证完成前，不能宣称这一真实路径通过。

## 预算读回

| 项目 | 数量 |
| --- | ---: |
| 两批累计物理 host 请求 | 34（旧 15 + 新 eval 18 + improve 1） |
| 原 host ledger known tokens | 61,560 |
| 原 host ledger UNKNOWN 预留 tokens | 1,056,768（1 次） |
| 原 host ledger charged upper tokens | 1,118,328 |
| 保守已知估价（1.2 USD / M） | USD 0.073872 |
| 保守已知加未知上界估价 | USD 1.3419936 |
| 诊断中另行观察到的 improve raw usage | 952 tokens |

952 与 SDK 用量一致，可作缺陷证据；**不得回写原 settlement 或把原 UNKNOWN 预留替换成 952**。作为单独的事后 raw 观察，两批共 62,512 tokens，按同一单价估算 USD 0.0750144；它不是原预算账本或账户账单。host 与 SDK/guest 是同一调用的不同观察，不能相加。累计预算没有越界。

19 次新 host 请求都核对了 raw response、HTTP 200、模型返回 alias `deepseek-flash` 与 fingerprint `aeb56401ca74e127821c4f9126dcb669`。这些证明保留响应中的标识，不证明不可变模型权重版本。账户实际账单未观察。

## 原件与工作范围

只使用 SQLite `mode=ro&immutable=1` 读取关闭后的原件，读取前后核对 **7,280** 个输入身份，其中包含 r2 原 **3,167** 个身份；全部不变。improve fixture 的四个文件与 frozen baseline 一致。provider boundary 源码匹配 frozen source-build；安装的 compiled boundary、OpenAI 7.19.0、pi-ai 1.1.0 相关文件匹配 frozen candidate identity。

原件留在 `/Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af-usd3-r3`。约 635 KB 的详细 facts 与约 2 MB 的完整 read index 留在外部目录，仓库保存本报告、精确路径/哈希、紧凑时间线及诊断脚本。读取记录中的代码和命令仅作为数据，未执行。诊断没有读取凭据，没有 provider 调用、VM 启动、产品执行或重测试。

collector 首次静态断言把 reopened result 的额外 `clock` 当作差异，已保留 `collect-r1-source.py` 和失败日志；第二次仅纠正对持久化元数据的比较，原 report 始终完全一致。此静态提取问题不改变真实产品失败。

后续需要单独修复 LIVE-USD3-R3-01、完成受影响复核并冻结新产品身份，再形成可审阅的下一 paid batch。下一批必须获得新的明确 one-start 授权；本报告不授权自动重跑。后续如有候选，仍须用户选择具体 report/revision/candidate。

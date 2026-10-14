# improve-only repair r1 独立评审

**Standards PASS；Spec FAIL（2 项 P2）。当前冻结 r1 不可用于新的付费授权申请。** 本报告只覆盖已冻结的 r1；producer 后续 r2 不在本结论内。

- manifest SHA256：`9a948eb693a20f5ca4d17443152fff0639465160628432d8d1f2eaa6b8cb1f8e`（74,214 bytes）。
- integrated candidate：`f26ae8f4b8039608a1fa796e1c69da4d8173d112`；producer：`78130b154fe8dad9097c05afb24ff9d1d24d8bce`。
- sourceBuild：`8f4ce2a273559d871b76c1cf14971a0df048d7f86b8216ff45b3d8dd2a710821`。
- artifact：`6608f6149f3e45051fc73eadcdb1dac8b77aa0d070070ef642ed3e26cd276661`；candidate gate：`21271432e2d61a85048c5be7d9679328b49286bf96ae86e299eb6801f945a47d`。
- 独立 reviewer：`/root/review_improve_only`，同一位独立 reviewer 分别评估两轴。请求模型 `gpt-6-astra` / `xhigh`；实际 backend **无法 attest**。

## Standards

PASS。遵循适用 AGENTS 与 code-review 的完整 Fowler smell baseline，未发现独立的文档标准硬违规或需要报告的可选 smell。预算/授权行为缺口归入 Spec，不重复计数。主协调当前的安装、体积、review 文档工作不属于本次 harness scope。

## Spec

1. **[P2] IMPROVE-R1-SPEC-01：最终账本失败仍退出成功。** `harness/run.mjs:39–42` 在 analysis 已完成、有候选且 cleanup confirmed 后，如果保存或读回 `cumulative-budget.json` 失败，catch 只增加 `cumulativeBudgetError`，仍保留 `AWAITING_ACTUAL_CANDIDATE_SELECTION`，并以 `0` 退出。冻结源码的两条内存探针均复现；没有真实产品运行。违反 review-request.md:12,15 的新失败停止及 terminal ledger 合同。应明确转入 `STOPPED_BUDGET_*`、非零退出，保留实际候选、原错误和已消费 one-start，不重跑。证据：[reviewer-ledger-failure-probe.json](reviewer-ledger-failure-probe.json)。

2. **[P2] IMPROVE-R1-SPEC-02：缺少授权作者与人类回复来源元数据。** `harness/preflight.mjs:84–90` 与 `harness/prepare-repair.py:53–54` 未要求 author 或原人类回复来源；现有 final preflight 对无这些字段的内存替身 PASS。违反 review-request.md:13 明确的 author/time/source 绑定。这是可审计性缺口，**不是对本地恶意同用户绕权的安全漏洞结论**。最小补充 `author="human-user"` 与 `source={kind:"codex-user-reply",requestToolCallId:<本次实际提问 call id>}`，缺失/错误字段应拒绝；连同既有 time/reply/manifest 由 authorizationSource hash 绑定。main 从当前直接人类回复采集即可，无需签名、登录或让用户提供 ID。

其余核对：只调用一次 `analyzeImprove`；原 fixture/synthetic seed、新 dataRoot、独立安装和 candidate gate 绑定正确；没有 eval/候选动作。旧 34 次请求、61,560 known + 1,056,768 UNKNOWN reservation 保留；新上限 8 次/1,200,000 tokens，累计 42 次/2,318,328 charged tokens，固定价格估算 USD 2.7819936。旧 raw 952 未替代 UNKNOWN，未重复相加 SDK/guest usage。一次启动 receipt、24h 启动/60m 活动窗口、安装后过期复核、重复信号 cleanup、旧 FAIL/UNKNOWN 与 7264+16 映射均保留。

## 验证与复用

复用 30 项 exact-source memory 检查、此前 2 项拒绝检查及最终 3 项真实 admission 拒绝检查。`final-preflight-check-r1.json` 使用内存授权替身核对了 7311 项实际引用；它不是真实授权。独立核对 38 个 identity/gate/check 绑定，当前 preflight/ledger/run hash 与既有检查一致；common/launch 与旧 r3 字节一致，原 12 项 parser checks 可复用。只新增了现有检查未覆盖的最终 ledger save/readback 两条失败探针；两条均暴露同一缺陷。

[独立 identity 核对](reviewer-identity-check.json)；[探针源码](reviewer-ledger-failure-probe.mjs)。`check-r1.json`、`check-r2.json` 及本轮失败探针原件均保留。没有修改 harness/product/root/state/Git，没有真实凭据读取、provider/VM/Terminal/产品执行、grant 或 paid-start。

## Reviewed harness hashes

| File | SHA256 |
| --- | --- |
| `common.mjs` | `643fa69f2e3d19033ea546f6f38fe82090914ea51d17f993e05b15dc529ba58d` |
| `freeze.mjs` | `1bd42f9aa15b2d4f4d90b1396527b9a8856f39ad04de08c9d190d8b0ddf9b0e6` |
| `launch.py` | `0bc874e203ee5d9ef975a3861db7c268d6a5f62c1a8d2c97b58316d07948b2e4` |
| `ledger.mjs` | `0a61bdce8e48e5e0bac3c2b880019987a12b5fd9cc8d14dbffaf42458a3d1df7` |
| `preflight.mjs` | `ec752343e4bed892a06ad684aae697ae350716f78f4af61a7e33058cc7c51230` |
| `prepare-repair.py` | `90d44f27886bb9c85c7f8d099ed5eac2f2699e3271eb2b7d350c0b7161af515c` |
| `run.mjs` | `45dcdd649a6f71bd680f1540d054a3a38bcc6bc858eb3ad194f040e902bf102d` |

## 后续授权文案

旧 r3 启动已经消费。本次两个问题修复后必须使用**新 revision 的完整 frozen SHA256**，重新核对受影响结果；不能沿用本 r1 的 hash 或报告通过状态。建议审批文字如下，仅供协调者在新评审完成后使用，不构成授权：

> 上一批 r3 的一次启动授权已经消费。本次申请针对新冻结 manifest <新 revision 的完整 SHA256>，仅启动一次 improve analysis，使用原 clamp fixture、原 synthetic seed 和新 dataRoot。新批最多 8 次请求、1,200,000 charged tokens，单请求预留上限 1,056,768、输出上限 8,192；保留旧 34 次请求及 1,118,328 charged tokens（含 UNKNOWN 预留 1,056,768），累计最多 42 次请求、2,318,328 charged tokens。按冻结最高列出单价 USD 1.2/M 估算上界 USD 2.7819936，仍受原累计 USD 3 上限约束；这不是账户账单或平台硬限额证明。仅在你的新回复后 24 小时内启动，活动截止为实际启动后 60 分钟，分析自身最多 5 分钟；固定凭据来源 /Users/nineofour/Durio/api.env。任何新 unknown、失败、鉴权失败、取消、超时或预算/记录失败都停止，不自动补跑。本次不运行 eval，也不选择、执行、验证、启用或写回任何候选；实际候选产生后另行展示 report/revision 与保护范围供你选择。是否授权这一次启动？

实际 backend、真实 provider 新调用及其 usage/cleanup 结果仍未证明；真实候选的 report/revision 选择仍待未来独立人类决定。本评审不完成 #30/#31/#32、全技术或日用验收。

Standards：0 项，PASS；Spec：2 项 P2，FAIL；Spec 最严重问题为最终 ledger 失败仍返回成功。

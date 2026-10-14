# improve output-contract r1 独立评审

**Standards PASS；Spec PASS，均为 0 项发现。** 本次是固定产品上的有界输入与历史预算承接评审，不授予新的付费启动，也不完成整体产品验收。

- manifest：`809aa5350c2d1d3cd3fac9281210ce41e2ff643e889a565bd15f25ae02e30856`（77,149 bytes）。
- batch：`pi-durio-v1-live-r4-improve-report`；request：`v1-live-r4-improve`。
- candidate：`f26ae8f4b8039608a1fa796e1c69da4d8173d112`；producer：`78130b154fe8dad9097c05afb24ff9d1d24d8bce`。
- sourceBuild：`8f4ce2a273559d871b76c1cf14971a0df048d7f86b8216ff45b3d8dd2a710821`；purpose：`adad8464a3cc3c68d128d852230b4eed1a90c1323b7582740d37c1310eec07cd`（1,524 bytes）。
- 唯一独立 reviewer `/root/review_improve_only`；请求 `gpt-6-astra` / `xhigh`；实际 backend **NOT_ATTESTED**。

## Standards

PASS。沿用适用 AGENTS 和完整 code-review smell baseline。改动保留既有 preflight/runner/ledger 结构，以额外 latest 层保留原 coding 历史和最近 improve 事实；未新增产品代码、第二账本或身份认证系统。没有文档标准硬违规或需报告的可选 smell。

## Spec

PASS。请求内容仅变更 id/purpose，并使用新 dataRoot；产品、安装、validator、fixture、source registrations、protected scope 和单阶段预算均未变。purpose 明确纯 JSON、候选必填项、已取得引用、事实/推断与 gaps 的区分，没有预填 clamp 修复公式或导入两份旧 raw 草稿。`activation.writeback` 只表达未来条件性意图，当前无选择/执行权限。

原 r2 已真实运行的 7 次请求增加 44,466 known tokens；最新 prior 为 **41 requests / 106,026 known + 1,056,768 UNKNOWN = 1,162,794 charged upper tokens**。新阶段最多 8 次/1,200,000 tokens；累计 **49 次/2,362,794 tokens**，按冻结最高 USD1.2/M 估价 **USD2.8353528 ≤ USD3**。旧 raw952 不回填，SDK/guest 镜像不重复相加。

`verifyPrior` 分别锁定原四类 coding PASS/outcome/grade 与全部旧 FAIL/UNKNOWN，以及最新已消费启动、正式 incomplete/0 candidates、原 revision、reopened、账本和读回索引。新授权必须晚于最新批次结束，绑定新 manifest/batch/kind/limits 和最新 prior；旧批准与来源拒绝。r2 的 provenance gate 和最终 ledger 失败 `STOPPED_BUDGET_RECEIPT_FAILURE` / exit1 修复完整保留。runner 唯一变化是 receipt 的 priorBudget 指向最新账本。

目的文本中的“最多一个候选”是本次**输入要求**。固定 validator 仍允许最多五个结构有效候选，本批没有新增 max1 宿主校验；评审不保证模型返回一个正确、完整或可执行报告。任何实际候选仍需人类针对 report/revision/baseline 的后续明确选择。

## 核对与复用

独立核对 **42 个身份绑定**，checked/frozen bytes 相同。当前受影响源码与 12 个 exact-source 用例一致；复用完整 frozen preflight（12,110 项实际引用、仅内存授权）与三条真实拒绝入口，共 16 项新增离线检查。原未受影响的 42 项不重跑；`common.mjs`、`launch.py`、`ledger.mjs` 与 r2 字节一致，candidate gate 函数和 runner 其余行为未变。没有新增行为 probe，也未执行产品。

[独立身份核对](reviewer-identity-check.json)与 [JSON 完整报告](independent-review.json)保存 exact hashes、复用范围和 first-failure 引用。旧两个 harness P2 的 FAIL/探针、旧 coding 首失败、旧 UNKNOWN、最新报告失败和诊断 collector 首失败均保留。

## 授权请求与 #31 增量

[main 的实际授权请求](authorization-request.md) SHA256 `f03efd98d2e291fd5e459984814470800324871120c66daf1fff11d796002fb2` 已核对为 **具体可审阅**：准确陈述消费的旧启动、新冻结身份、范围和累计预算、24h/60m/5m窗口、固定凭据来源、失败停止及未来选择边界。请求不是授权；当前新 grant、authorization-source、paid-start、authorized-plan 均不存在。

`issue-31/improve-only-repair-r2/CONTRACT-DELTA.md` 和 `contract-delta.json` 仅增加 7 次真实 known 结算、cleanup/storage、正式报告失败及最新累计预算事实，证据身份吻合。明确保留 `PARTIAL_TECHNICAL_ACCEPTANCE_NOT_COMPLETE`、remote termination unknown、未完成候选链和日用接受；没有冒充整体 PASS、不可变模型权重或新性能结论。

## Reviewed harness hashes

| File | SHA256 |
| --- | --- |
| `common.mjs` | `643fa69f2e3d19033ea546f6f38fe82090914ea51d17f993e05b15dc529ba58d` |
| `freeze.mjs` | `128428df533c48fdc33529503230c2e84c40011c4538d0601f0291235fcfbae7` |
| `launch.py` | `0bc874e203ee5d9ef975a3861db7c268d6a5f62c1a8d2c97b58316d07948b2e4` |
| `ledger.mjs` | `0a61bdce8e48e5e0bac3c2b880019987a12b5fd9cc8d14dbffaf42458a3d1df7` |
| `preflight.mjs` | `7f1589074f31de5b8e030256b5a003e78587dc621dabb84857b3db65b83d0452` |
| `prepare-output.py` | `3f084330e257fd95bbe12fa10097d78a212dd9c6511095f99736a6b5cfde5153` |
| `run.mjs` | `dd37dad031bb87757a91357c75abe041d5a29804189d15cf433357c76a02f456` |

本 reviewer 仅写当前 review 目录；没有读取真实凭据，未调用 provider/VM/Terminal，未导入或执行产品、操作候选、创建真实授权或修改 root/state/Git。后续由 main 读回后按授权流程推进；真实新启动仍等待人类明确决定。

Standards：PASS，0 项；Spec：PASS，0 项。授权请求与 #31 事实增量通过本范围核对，整体技术和日用验收仍未完成。

# USD3 独立评审：BLOCKED

固定 manifest：`f0ccad818a62f66d00e274f4efba03c52d4e5570f465476500dbe6fd1642aecc`。产品：`9aed1af6ee3b156bb7354961496217aa5e64843e`；集成文档 HEAD：`14787f0dfaadf69b6c235e5bb650d9f923a5d5a1`。范围是外部 USD3 proposal / harness / wrapper；由一名独立 reviewer 分别评审两轴。

## Standards

PASS：0 hard defects，0 optional smells。已读取项目 AGENTS.md 与 code-review 技能完整 Fowler baseline；未发现可报告的文档规则违规。生成器与严格派生校验、外部副本与原脚本的重复有明确身份核验用途，无额外重构建议。

## Spec

BLOCKED：1 个 P2 hard defect。

**USD3-SPEC-01 — 在实际启动边界重新检查原授权有效期。** [run.mjs:16](/Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af-usd3/harness/run.mjs:16) 在 preflight 之后执行安装、异步模块与运行时身份检查，然后生成 `startedAt` 并写 `paid-start.json`，没有再次比较原 `grantedAt + 24h`。这违反 proposal 的 “One start within 24 hours of grant”。[内存 probe](/Users/nineofour/pi-durio-v1-run/review/usd3/expiry-probe-result.json) 用精确冻结源码于到期前 1 ms 通过 preflight，模拟准备耗时至到期后 1 ms，仍进入 `prepareEval` / `runEval`。建议在实际 `startedAt` / 原子 `wx` 写入之前重新校验原时间，并为跨期准备补一条离线回归；无需修改产品或 rebuild。

## 证据与边界

- manifest 所列 16 个内容条目均匹配；原 proposal 仅有 15 个声明中的 leaf 变化；18 个历史原件仍匹配。
- `common.mjs` 全文字节一致；`run.mjs` 从 `const identity` 起的原行为主体一致。预算为 eval 32 / 1.2M、improve 8 / 1.2M，总 40 / 2.4M；冻结费率推算 USD 2.88，cap USD 3。
- 复用 [24 项预检](/Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af-usd3/offline-checks/summary.json) 与 [12 项凭据检查](/Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af-usd3/credential-check-r1.json)，未重复运行。新增 probe 只用内存合成 API / literal credential，未读取真实 api.env、未创建真实 grant、未执行 provider / VM / build。
- 所有实际评审或身份核验文件的 path / bytes / SHA-256 见 [review.json](/Users/nineofour/pi-durio-v1-run/review/usd3/review.json) 的 `reviewedFiles`。完整 [probe 源码](/Users/nineofour/pi-durio-v1-run/review/usd3/expiry-probe.mjs) 保留。
- 新批次尚无真实 `explicit-human-grant.json` 或 `paid-start.json`。本结论不代表 #30 实测、native technical、日用接受或真实费用验收；native 首次失败和原 USD5 / 离线首次失败均保留。

当前执行前存在 1 个代码硬阻塞。Standards：0 项，最严重无；Spec：1 项，最严重 P2。

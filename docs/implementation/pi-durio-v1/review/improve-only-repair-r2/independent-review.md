# improve-only repair r2 受影响独立复核

**Standards PASS；Spec PASS。r1 两项 P2 均在本冻结 r2 上解决。** 该结论允许向人类呈现具体授权请求，本身不授予新 paid start。

- frozen manifest：`c1a3904f047ff3c19b16ba7c7e66dc57316f2ff9ad08a7080791ee5babe5fb2a`（76,288 bytes）。
- candidate：`f26ae8f4b8039608a1fa796e1c69da4d8173d112`；producer：`78130b154fe8dad9097c05afb24ff9d1d24d8bce`；sourceBuild：`8f4ce2a273559d871b76c1cf14971a0df048d7f86b8216ff45b3d8dd2a710821`。
- artifact：`6608f6149f3e45051fc73eadcdb1dac8b77aa0d070070ef642ed3e26cd276661`；独立 source/applicability gate：`21271432e2d61a85048c5be7d9679328b49286bf96ae86e299eb6801f945a47d`。
- reviewer：`/root/review_improve_only`，唯一活动独立 reviewer，继续 r1 的受影响复核。请求 `gpt-6-astra` / `xhigh`；实际 backend：**NOT_ATTESTED**。

## Standards

PASS，0 项新发现。修复局限于既有 catch/gate、模板及冻结引用，沿用原错误和状态结构。没有新增授权身份认证系统、权限范围或第二账本；完整 smell baseline 未产生需要报告的新增问题。

## Spec 与原 finding disposition

| 原 finding | r2 disposition | 核对结果 |
| --- | --- | --- |
| `IMPROVE-R1-SPEC-01`（P2） | RESOLVED_ON_FROZEN_R2 | `run.mjs:40` 对最终 ledger 构造/保存/读回异常明确设置 `STOPPED_BUDGET_RECEIPT_FAILURE`、unknown，:42 退出 `1`。两个 exact-source 用例确认保留 analysis、reopened report、候选数和 paid-start，只调用一次分析；原错误保留，不重跑。 |
| `IMPROVE-R1-SPEC-02`（P2） | RESOLVED_ON_FROZEN_R2 | `preflight.mjs:87–89` 要求 `author="human-user"`、`source.kind="codex-user-reply"` 和非空本轮 `requestToolCallId`。六条缺失/错误拒绝用例在产品/凭据 effects 前失败。字段由原 authorizationSource hash 连同 reply/time/manifest 绑定。 |

来源字段用于审计。main 必须从当前直接人类回复采集实际 call ID、原文和时间；字段校验不被表述为同用户对抗性身份认证。模板没有实际 reply/time/call ID，grant 仍为 false。

预算、单次 improve-only 范围、原 fixture/synthetic seed、身份及 source/applicability gate 均未改变。新批上限 8 次/1,200,000 charged tokens；旧 34 次/1,118,328 charged tokens（含 1,056,768 UNKNOWN）继续保留；累计 42 次/2,318,328，冻结单价估算 USD 2.7819936。没有 eval、自动选候选、执行、验证、启用或写回授权。

## 验证与复用

已收到 producer 完整 frozen hash 与最终 check hashes，再独立核对 38 个文件/身份绑定；checked-manifest 与 frozen-manifest 字节相同。当前源码匹配 30 项 admission + 8 项修复 checks；复用完整最终 preflight（7,320 项实际引用，授权只在内存替身中）和三条真实 admission 拒绝记录。已读受影响源码及检查断言，未重跑仍适用的确定性行为检查。

`common.mjs`、`ledger.mjs`、`launch.py` 与 r1 字节相同。旧 r1 独立 FAIL、原两个 P2 和 `BUG_REPRODUCED` 探针被新 manifest 引用并保留，r2 通过不会把 r1 改判为通过。

[独立身份核对](reviewer-identity-check.json)；完整 checks SHA 和证据见 [JSON 报告](independent-review.json)。

## Reviewed harness hashes

| File | SHA256 |
| --- | --- |
| `common.mjs` | `643fa69f2e3d19033ea546f6f38fe82090914ea51d17f993e05b15dc529ba58d` |
| `freeze.mjs` | `75d152dd8801dee65ddeada359b50789237ebac38ca7f780dd9a43db4866df08` |
| `launch.py` | `0bc874e203ee5d9ef975a3861db7c268d6a5f62c1a8d2c97b58316d07948b2e4` |
| `ledger.mjs` | `0a61bdce8e48e5e0bac3c2b880019987a12b5fd9cc8d14dbffaf42458a3d1df7` |
| `preflight.mjs` | `4926e7978cf23eb642dc2ac78f61f68fe6d2c77f6f674a3571be3e0992a69bdc` |
| `prepare-repair.py` | `15ec67c3695f336a074196d40455c824a2a92c1803cf2480c75611cf3182e642` |
| `run.mjs` | `c2eb991f269fc3ccd6939da0f92135035f0956de3cfd013ec9d32bd3ef976a2c` |

## 新授权请求

main 的[实际授权请求](authorization-request.md)已逐项核对为 PASS：绑定本 r2 完整 manifest SHA、范围、预算、旧启动消费事实、时间窗口和未来候选选择边界；明确该文本不是授权回执。原文件未修改。可由 main 现在向人类呈现；尚未收到任何新 paid-start 批准，也未创建真实 grant/paid-start/authorized-plan。

实际新 provider response/model identity、usage、cleanup 与候选仍待未来获准执行才有证据。后续候选必须另行绑定 report/revision/baseline 供人类选择。本报告不完成 #30/#31/#32、完整技术验收、日用接受或发布。

仅写本 review 目录；没有读取真实凭据、执行产品/provider/VM/Terminal，或修改 root/state/Git。

Standards：PASS，0 项；Spec：PASS，0 项未解决问题，原 2 项 P2 在本 r2 解决。

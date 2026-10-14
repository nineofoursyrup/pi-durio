# #30 USD 3 补充批次 r3

状态：**FROZEN / AFFECTED OFFLINE CHECKS PASS / INDEPENDENT REVIEW PENDING / PAID NOT RUN**。这已将 r2 首失败诊断后的方案落实为可执行外部 runner、准确清单及 `paidApproved:false` 模板。产品仍为 `9aed1af6ee3b156bb7354961496217aa5e64843e`，source-build 仍为 `0559e34005b6b6f981af0b09877f4a8c4d7bcb15dc05e9ce21435370145d6886`；没有修改产品源码、构建、安装或依赖。

准确清单：`/Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af-usd3-r3/frozen-manifest.json`，SHA256 **`07ed36fdeb17f24d7e8d6caea0db4efd41dd31111fa7ef6ea4cb0a51daa0251e`**，10,012 bytes。`checked-manifest.json` 与最终冻结清单逐字节相同；离线检查绑定同一 SHA。仓库目录仅保存这些文件的审阅副本，实际执行路径是上述外部目录。

## 准确执行范围

新 batch ID 为 `pi-durio-v1-live-r2-usd3-supplement`，执行三个新 trial：`v1-live-r2-multi-file`、`v1-live-r2-regression`、`v1-live-r2-no-change`。原案例 prompt、初始/脏文件、允许改动范围和 grader 不变。每个编码任务正式 runtime 仍最多 8 次请求。multi-file 从原 fixture 新建，明确关联原失败 `v1-live-r1-multi-file`，不续跑失败会话。

原 `local-fix PASS` 作为冻结依赖复用。`preflight` 验证它的准确 outcome/grade/source/runtime，并重新核对原读取身份索引中的 3167 个文件/object；原 `multi-file error / grade unknown`、两项 not-run 和 r2 `STOPPED` 均必须保持。新 eval 只有在三个准确 trial 都是 `completed / valid / started`、grade 为 PASS 且引用对应 outcome、用量已知且无上界违反时，才允许进入 `improve`。

实际 `improve` request 为 `v1-live-r2-improve`，仍使用原 clamp fixture、原 synthetic seed 及只读分析范围。只克隆原未执行的 seed data roots，不克隆或覆写已付费失败的 r2 data root。实际候选、revision、baseline、保护文件、检查和写回范围仍要另行返回人选择；此启动授权不选择未来候选。

即使本批次通过，也应分别报告原批次与补充结果：四个不同案例跨两批次都有 PASS 证据，同时保留一次实际执行失败。不能把原单次结果改成 4/4 PASS，不能删除原 UNKNOWN 或 not-run。

## 累计预算与停止门

| 边界 | 已发生 | 新批次上限 | 跨批次上限 |
|---|---:|---:|---:|
| 物理 provider requests | 15 | 32（eval 24 + improve 8） | 47 |
| tokens | 27,499 | 2,372,501 | 2,400,000 |
| 原冻结 USD 1.20/M 保守估算 | USD 0.0329988 | USD 2.8470012 | USD 2.88 |
| 美元总帽 | 计入累计 | 使用累计余量 | **USD 3** |

原 40 次是已结束首批次上限；本批次新增最多 32 次、累计最多 47 次，需要新的明确授权。新 eval token 上限 **1,172,501**，单请求 reservation **1,052,672**；improve 保留完整 **8 requests / 1,200,000 tokens**，单请求 reservation **1,056,768**。输出仍为 **4096 / 8192**。正式产品阶段预算负责 admission，外部账本只汇总准确 host reservation/settlement，不重复计算 guest/SDK 镜像。

剩余 eval 额度可容纳一次 reservation。每次结算、剩余额度和期限仍决定能否继续；请求上限不是完成保证。未知结算继续占用 reservation；若收尾账本无法读取某阶段，则保守保留该阶段全部额度并报告 UNKNOWN，不将其当作零用量。账本无法给出 provider 账户硬消费上限或实付金额。

首个非 completed / 非 PASS、认证、取消、deadline、预算或用量上界问题会停止后续阶段，不自动补跑、重启或修改 prompt/模型/8 次限制。原 signal handlers、认证停止、安全凭据 wrapper 沿用；增加的最终累计账本在 handlers 移除前保存。安装校验后再次验证原证据，再以实际 `startedAt` 复核新授权的 24 小时窗口，活动期限固定为其后 60 分钟。

## 检查及首失败

[checks.json](checks.json) 记录 35 项新离线检查：

- 25 项准确冻结 runner/preflight 的内存夹具检查：旧授权/错误预算/改动原证据/重复启动拒绝、安装跨到期边界、准确三例 PASS 门、UNKNOWN、401、重复取消、零候选和无法读取的账本。
- 8 项准确安装 `PersistentBudget` 类的内存 Evidence 检查：新 eval 的 reservation、精确 token 边界、未知结算和 24 次 ceiling；improve 8 次完整额度与未知用量停止。合成小用量能达到请求 ceiling，仅证明预算算术，不预测真实任务完成。
- 2 项实际 wrapper + 新 preflight 的缺失/false grant 拒绝检查；credential reader 被禁止访问夹具替代，没有打开实际凭据。

第一轮检查的 [FAIL](supplement-check-r1.json) 和 [原检查脚本](check-supplement-r1-source.mjs) 保留：内存夹具将账本保存进 Map，却没有把 `file()` 接回该 Map，导致有效路径的收尾读取失败。第二轮只修复检查夹具的 read adapter；冻结执行源码与 manifest 没变，[25 项检查](supplement-check-r2.json) 随后通过。原真实 multi-file 首失败与更早 USD 3 expiry 审查首失败也保持不变。

安全 wrapper 逐字节不变，因此明确复用原 12 项凭据 parser/file-policy 检查。未重跑产品 build、全量测试、真实 provider 或 restricted VM。原始 3167 个读取过的文件/object 在准备后再次核对，0 变化。

## 新授权所需材料

本目录只有 [false grant 模板](grant-template-NOT-EXECUTABLE.json) 和 [授权来源模板](authorization-source-template-NOT-EXECUTABLE.json)，没有 `explicit-human-grant.json`、`paid-start.json` 或 `authorized-plan.json`。

协调者在准确清单独立 review 通过后，向用户取得一次新的明确启动批准，记录真实 `receivedAt`、`exactHumanReply`、本 manifest SHA、新增/累计预算和原 manifest SHA。记录必须是 `kind: supplemental-one-start`，时间晚于原批次结束；旧 USD 3 授权不得复用。grant 的 `authorizationSource` 绑定该记录的准确 path/bytes/SHA，`grantedAt` 必须等于原记录时间，不能为延期重写。启动前应确认原冻结价格仍适用及资源检查已结束。

届时仅由协调者执行固定 wrapper：

```sh
/usr/bin/python3 /Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af-usd3-r3/harness/launch.py
```

这份文档、false 模板、旧凭据就绪确认和离线 PASS 都不授权执行。准备阶段实际凭据读取、provider 请求和 restricted VM 启动均为 0。差异见 [revision-delta.json](revision-delta.json)，原首失败诊断见相邻 r2 `postrun-diagnosis`。

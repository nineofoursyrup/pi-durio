# #30 USD 3 派生批次

历史初版：独立审查结论 **BLOCKED**，见 [independent-review.json](independent-review.json)。原检查结果保持其原适用范围；仅 [r2](../final-9aed1af-usd3-r2/README.md) 已修复启动期限问题并通过定向复核。本目录冻结入口不得用于执行。

状态：**PREPARED / OFFLINE CHECKS PASS / PAID NOT RUN**。用户已明确“额度不超过3 usd”；本轮完成预算收紧和独立外部入口，不创建可执行 grant，不读取实际 `api.env`。真实 provider、VM、实际 improve 报告和候选选择均未执行。工作树基于 `14787f0dfaadf69b6c235e5bb650d9f923a5d5a1`，产品仍为 `9aed1af6ee3b156bb7354961496217aa5e64843e`。

实际执行清单为 `/Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af-usd3/frozen-manifest.json`，SHA256 **`f0ccad818a62f66d00e274f4efba03c52d4e5570f465476500dbe6fd1642aecc`**。本目录保存相同字节的可审阅副本；清单绑定外部路径。完整 proposal SHA256 为 `9312057d264c70e65df4dd1217bc82909c96ad27b6c832292220287c978656f9`。

| 范围 | 原申请 | 本次固定值 |
| --- | --- | --- |
| aggregate tokens | 4,000,000 | 2,400,000 |
| eval tokens / requests | 2,000,000 / 32 | 1,200,000 / 32 |
| improve tokens / requests | 2,000,000 / 8 | 1,200,000 / 8 |
| 单请求保守 reservation | 1,052,672 / 1,056,768 | 原值保留，两阶段各能容纳一次 |
| 最高公开单价 | USD 1.20/M | 原值保留，新官方 HTTP 200 快照核对 |
| 保守估算 / 授权上限 | USD 4.80 / 5 | USD 2.88 / 3 |
| 授权后启动期限 / 整批期限 | 24 小时 / 60 分钟 | 原值保留，只能启动一次 |

四个 trial 的内容、顺序、次数、grader、输出上限、停止规则、实际安装、源码/build/package、Linux runtime 和 synthetic seed 均保留。[derivation.json](derivation.json) 逐项记录 15 个 proposal leaf 差异：预算、派生 batch/eval ID、新记录路径、许可凭据来源与新公开价目证据引用。

授权时点固定为 `2026-10-10T05:34:25.010886Z`，不得因准备、评审或创建 grant 而刷新。只接受原文“额度不超过3 usd”、原记录来源和此清单的准确 SHA。旧 USD 5 grant、扩大任一阶段、重新分配阶段额度、扩大 requests/window、降低 reservation、价目变化、重复启动、已有授权计划、缺少原授权来源和失效授权均在安装 API 或凭据环境查询前拒绝。

公开价目引用协调者于 `2026-10-10T05:37:29.408055+00:00` 保存的[官方价格](https://api-docs.deepseek.com/quick_start/pricing/)与[模型元数据](https://api-docs.deepseek.com/api/list-models/) HTTP 200 HTML；retrieval 与两个 HTML 的路径和 SHA 均进入冻结清单。这是公开文档观察，不是认证后的服务身份、实付账单或账户硬消费限额。遇到已知价目变化必须停止。

## 外部入口及凭据边界

`harness/common.mjs` 与已审原件全文相同。`harness/run.mjs` 从 `const identity=...` 开始至文件末尾与原件逐字节相同，产品加载、计划物化、401/403 停止、未知结果、deadline、SIGINT/SIGTERM、重复信号、清理等待和结果记录逻辑沿用原证据。变化仅在前置门：由 `preflight.mjs` 严格核对原清单、原 proposal、唯一允许的 USD 3 派生值、stage/request 总和、价目、窗口、grant 和全部冻结文件。原产品 `scripts/live-batch/prepare.mjs` 没有改变，也未重新运行。

`launch.py` 是协调者未来唯一凭据入口，固定读取 `/Users/nineofour/Durio/api.env`，不接受路径参数，不执行 shell source。它先运行冻结 preflight，拒绝后不打开凭据文件；通过后用 `O_NOFOLLOW` 打开文件，检查 regular file、当前 owner 和准确 `0600`，只解析一条 `DEEPSEEK_API_KEY` 赋值。值、长度、hash 和解析异常内容均不输出或持久保存。随后 `os.execve` 替换为 Node runner，保留运行阶段原信号和退出码；runner 会再次执行前置门。

未来命令（本轮没有执行真实入口）：

```sh
/usr/bin/python3 /Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af-usd3/harness/launch.py
```

只生成了 `grant-template-NOT-EXECUTABLE.json`，其中 `paidApproved:false`。协调者完成独立审查、核实另存的用户凭据就绪确认、确认 native/resource 工作已结束，并检查原 24 小时窗口后，才能创建准确的 `explicit-human-grant.json`。本批授权不选择任何未知未来 improve 候选。

## 原证据与验证

原 `final-9aed1af` 没有 `paid-start.json` / `authorized-plan.json`；eval journal 仅有 staging 的 `eval.content`、`eval.plan`、`evidence.fixed`，improve journal 没有 improve 记录。新数据根使用已关闭数据根的 APFS clone，保留原字节、分离 inode 和后续写入；没有重做约 12k 个 blob 的 prepare。18 个原 manifest/proposal/seed/journal/fixture 等文件在前后核对相同。

seed 内 `task.accepted.workspace` 绑定原真实 workspace，现有 `analyzeImprove` 会拒绝换成另一条路径。因此只读分析沿用原 `improve-project` 路径，新 journal 和输出写在 sibling 中；没有改 seed 或伪造来源。以后实际候选的写回仍须另行处理准确 baseline 和选择范围，不能在本次分析阶段修改原 fixture。

- [preflight-check-summary.json](preflight-check-summary.json)：24 项真实子进程检查，通过旧上限、阶段扩大、额度重分配、请求数、窗口、price、reservation、授权来源、时间、重复 start 和 wrapper 负例；正例物化 1,200,000-token eval 计划后由离线 API 返回停止，未执行真实请求。
- [credential-check-r1.json](credential-check-r1.json)：12 项临时文件检查，覆盖空值、额外变量、重复赋值、命令替换、shell 语法、权限、过大文件、symlink、非 regular file 和 owner。
- [checks.json](checks.json)：脚本语法、原文件保留、产品 sourceBuild hash 及 run/common 复用适用性。保留原 stdout/stderr；本轮没有失败后改写的检查结果。

测试仅替代 installed product API 边界，使用人工占位凭据；不证明真实 provider、VM 取消、费用实付或 #30 闭环。沿用 `repair-30-cancel/compiled-r2.log` 的 6 个测试/8 个场景和原 `auth-stop-r2` 的适用证据；本次未重跑 VM、build、全量产品测试或资源测量。实际完整 installation/runtime 校验仍由付费 runner 在计划物化前执行。[handoff.json](handoff.json) 给出协调者后续步骤；本轮没有 commit、push 或 GitHub 写入。

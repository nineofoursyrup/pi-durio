# LIVE-USD3-R3-01 修复后的 improve-only 批次

当前状态：**已绑定独立源码与适用性 PASS 并冻结，等待独立 harness review 和新的单次启动授权**。只有 `paidApproved:false` 的模板；没有 `explicit-human-grant.json`、`paid-start.json` 或真实授权。准备阶段未读取凭据、调用 provider、导入/执行产品或启动 VM。

本批次只做一次真实 improve analysis，使用原 clamp fixture、原 synthetic seed、原固定工具和原输出要求。新 batch 为 `pi-durio-v1-live-r3-improve-repair`，新 request 为 `v1-live-r3-improve`，使用新的 `improve-data` 根。没有 paid eval、候选选择、候选检查、激活或写回调用。

## 范围和累计预算

| 项目 | 保留旧两批 | 新一批上限 | 累计上限 |
| --- | ---: | ---: | ---: |
| 物理 host requests | 34 | 8 | 42 |
| known tokens | 61,560 | — | — |
| UNKNOWN 预留 tokens | 1,056,768 | — | — |
| charged tokens（known + reserved） | 1,118,328 | 1,200,000 | 2,318,328 |
| 最高列出单价估价 USD | 1.3419936 | 1.44 | 2.7819936 |

新阶段 `maxRequestTokens=1,056,768`、`maxOutputTokens=8192`、`maxDurationMs=300000`；阶段额度可容纳一次完整 reservation。真实 usage 结算后才释放该请求的多余 reservation；8 是请求上限，不保证模型在额度内产生候选。

原 `cumulative-budget.json` SHA256 `07e58fa36dc54441da52658e2eed29a0ad35eff233b8b2817bc28b2fe1e3b997` 固定不变。旧 unknown=1 可以作为已结束批次的保守占额进入新计划；新一次分析中出现 unknown、超额、鉴权失败、取消或超时即停止，不自动补跑。r3 raw usage 952 仅作根因证据，不替换旧 host UNKNOWN。

新 one-start 授权必须绑定新 frozen manifest，`receivedAt` 晚于 r3 结束 `2026-10-10T06:41:35.851Z`，并与新授权记录匹配。24 小时启动窗口和从实际启动起 60 分钟活动窗口保持原边界。旧 USD3 回复、旧 grant、旧授权来源和已消费启动不可复用。

## 原始证据与新产品身份

固定 integrated candidate 为 `f26ae8f4b8039608a1fa796e1c69da4d8173d112`，repair producer 为 `78130b154fe8dad9097c05afb24ff9d1d24d8bce`。两者职责不同，gate 绑定前者；新 source-build 为 `8f4ce2a273559d871b76c1cf14971a0df048d7f86b8216ff45b3d8dd2a710821`，具体已读身份见 `artifact-binding-precheck.json`。独立源码 review / 受影响适用性 gate 已 PASS；harness review 仍 PENDING。

旧 r2/r3 的 7,264 项闭合证据按哈希保留，涵盖 raw response、SQLite、manifest、outcome、grade、预算、旧 report 和首失败。postrun 曾核对的另外 16 项按以下方式处理，完整映射在 `retained-prior-code.json`：

- 3 个可变 worktree 源文件：使用 `git show 9aed1af6ee3b156bb7354961496217aa5e64843e:<path>` 获取精确旧版本，核对原 hash 后保存到 `prior-source-9aed1af/`。
- 9 个旧 artifact/独立安装/source-build/compiled/SDK 身份：仍逐一核对原不可变路径与 hash。
- 4 个原 improve fixture 文件：继续受 frozen fixture hash gate 保护。

原“7,280 项读前读后不变”是当时的历史观察，原报告未改动。新候选允许合法修改当前 worktree 源码，不要求其永远等于旧候选。

四类 coding PASS 保留原执行候选 `9aed1af`、原 trial/outcome/grade。`candidate-gate-template-NOT-FROZEN.json` 要求实际修复候选、独立 repair PASS 和受影响 coding/native 适用性复核证据，不把旧执行标成新候选重跑通过。旧 r2 multi-file 的 error / unknown，以及 r3 improve 的 0 候选 / incomplete / UNKNOWN 均保留。

## 准备与冻结

`harness/prepare-repair.py` 只读旧闭合证据，并把原 synthetic seed 独立 APFS 复制到新的 dataRoot；没有复制失败 paid run。`harness/freeze.mjs` 只在协调者提供真实新 artifact、独立 repair/applicability gate 后绑定 checked draft，供最终身份核对和独立 harness review。它不会生成真实授权。

`harness/launch.py` 与前一已审 wrapper 字节相同，固定唯一凭据来源；先通过 preflight，再加载凭据并替换到 runner。runner 在安装身份检查后再次验证实际 startedAt 对授权窗口的有效性，避免检查耗时跨过过期边界。SIGINT/SIGTERM 清理与最终账本写完前保留处理器，重复信号不强制跳过清理。

## 离线检查

当前 exact-source memory fixture 30 项 PASS（`check-r5.json`）；实际 false/missing grant 拒绝路径 2 项 PASS（`wrapper-check-r3.json`）。全部 candidate、授权、API 和输出回执替身仅在内存中，不能作为真实新 candidate 或授权证据。原 12 项凭据 parser checks 因 wrapper 字节不变而复用。Python/Node 语法及 JSON 检查通过。

保留的首个离线失败：`check-r1.json` 是测试预置了旧 receipt 后却断言 receipt 不存在；修正为不得新建/替换原 receipt。`check-r2.json` 发现新 preflight 对预算小数使用二进制浮点直接相等；改为整数单价单位 `tokens * 12 / 10000000`，得到声明的精确十进制上界。源码、失败日志和之后的 PASS 都保留，没有改变金额、tokens 或授权边界。

最终 manifest SHA256 为 `9a948eb693a20f5ca4d17443152fff0639465160628432d8d1f2eaa6b8cb1f8e`（74,214 bytes）。新候选完整 preflight 已使用仅存内存的模拟授权通过，读取 7,311 项真实引用；实际 false-pinned grant、missing grant 和 wrapper missing grant 三条入口均按要求拒绝。没有真实授权或 paid-start。原 30 项 exact-source PASS 因冻结源文件相同而复用。具体见 `final-preflight-check-r1.json` 和 `final-denials-r1.json`。

独立 harness review 与新用户 one-start 尚待完成。即使未来 analysis 返回候选，也必须另行给出精确 report/revision/candidate、baseline 和保护范围供人类选择，paid grant 不代替选择。


外部完整证据目录：`/Users/nineofour/pi-durio-v1-run/evidence/issue-30/improve-only-repair-r1`。仓库副本只含必要源码、摘要、最新检查及首败跟踪；完整 2 MB 原始清单、旧源码快照和较大历史检查留在外部，由 `evidence-index.json` 按绝对路径和哈希引用。

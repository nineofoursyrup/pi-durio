# #30 真实批次准备

当前状态：**PREPARED / PAID NOT RUN / CANDIDATE NOT SELECTED**。没有读取凭据、认证或真实模型调用；#30 仍未完成。只增加批次脚本、固定 fixture 和说明，未修改产品源码、依赖或评分规则。

## 取消入口修复与准备适用性

`run.mjs` 现在将 `SIGINT` / `SIGTERM` 接入两阶段共用的 `AbortController`，先保留 `cancellation-request.json`，等待当前公开 API 已有的清理/关闭边界，再保存 `batch-result.json`。首个信号决定退出码（130 / 143），重复信号不会跳过清理。准备期间取消不启动 eval；eval 取消不启动 improve；已取得的结果、失败和清理未知继续保留。取消及 API 返回均不证明远端请求或所有外部进程已停止，未运行项不得自动续跑。

入口同时核对当前实际执行的 `run.mjs` 与它加载的 `common.mjs` 均在冻结 harness 中，继续校验完整文件 hash。**下述 prepared-r1/r2 是不可改写的历史准备证据，不覆盖当前修复入口，也不构成当前执行授权。** 新入口必须重新冻结实际脚本、重新核对安装/输入/预算/期限适用性，取得针对新 manifest 的具体人工付费授权与许可凭据来源；旧 manifest 和旧检查不得改标为新版本通过。本次没有生成新付费清单或授权。

`test/live-batch.test.ts` 直接启动当前入口和 `common.mjs`，只将公开 installed product API 换成临时离线安装夹具。实际进程信号覆盖延迟清理、重复信号、准备阶段取消、清理失败、improve 未知，以及旧入口/旧 helper/内容漂移拒绝。它验证准备入口控制流，不证明真实 provider、VM 取消或 A1 真实闭环。首次失败及结果保存在 `/Users/nineofour/pi-durio-v1-run/evidence/repair-30-cancel/`；原 prepared-r1 全部保留。真实付费授权仍为 **NOT GRANTED**，实际 provider / 凭据读取 / VM 启动均为 0。

## 可审阅批次

历史冻结清单位于 `/Users/nineofour/pi-durio-v1-run/evidence/issue-30/prepared-r1/frozen-manifest-r2.json`，SHA256 `fd9b8b5741e8ec9f7ef1dff965e6abcbedda33a668ea4cdd7b318881e9d90892`。它绑定当时的完整 proposal、实际安装/源码/build/Linux runtime、输入、grader、seed 和执行脚本。完整 proposal 为同目录 `candidate-r2/proposed-batch-r2.json`，SHA256 `aed354567fe633b8cb262b5a0c4e885d8b0ca2ef06bad7ce2cb7b28f20a8dfbf`。原 `frozen-manifest.json`（`d80e894a…`）保留，r2 增补安装集合身份门；当前取消修复后的入口不再适用这份旧冻结清单。

| 项目 | 固定范围 |
| --- | --- |
| Provider | `deepseek` / `deepseek-flash` / `https://api.deepseek.com/chat/completions`，无备用模型或端点 |
| 四个 trial | `v1-live-r1-local-fix`、`v1-live-r1-multi-file`、`v1-live-r1-regression`、`v1-live-r1-no-change`，按此顺序，各 1 次 |
| Eval 限制 | 共享最多 32 次实际 dispatch、2,000,000 tokens；每请求输出最多 4096；每 trial 300 秒，评分 30 秒 |
| improve | `v1-live-r1-improve`，1 次分析；最多 8 次 dispatch、2,000,000 tokens；每请求输出最多 8192；分析最多 300 秒 |
| 整批 | 最多 40 次 dispatch、4,000,000 tokens；实际模型请求、自动 compaction 和任何可发生的 transport retry 共享原阶段预算，不按 operation ID 重置 |
| 期限申请 | 获授权后 24 小时内启动一次，两阶段共用从该次启动起 60 分钟的绝对截止时间；准备时间也计入；中断/取消/过期后不自动续跑、补跑或替换 trial |
| 费用申请 | USD 5；按官方所有 token 类别最高单价 USD 1.20/M 得到 USD 4.80 的保守 token 费用估算；不是实付账单或账号硬限额 |
| 凭据 | 只从用户明确指定的本地来源载入 `DEEPSEEK_API_KEY`；当前来源待定，未读取或认证 |

[cases.json](cases.json) 保存四个案例完整字节、dirty 输入、允许写入路径、固定评分程序和必要要求。前两例要求真实修复/跨文件接线；回归与不改动反例要求现有正确行为和目标未变。全部为公开开发 fixture，不能声称未见测试集或总体稳定性。

[provider-observation.json](provider-observation.json) 记录官方来源及 2026-10-09T20:32:08Z 的观察口径，区分检索观察、缓存抓取时间、原始定价生效时间和账号实付。公开直接打开超时仍保留；未作任何认证查询。固定产品对每次 eval 请求保留 1,052,672 tokens，improve 保留 1,056,768 tokens，只有已取得 settlement 才释放未用保留。未知用量不归零。两阶段分别使用既有 `PersistentBudget`，总上限是两个阶段上限之和，没有新 usage 账本。

## 实际工件与 seed

实际生产者为 `52f8dd25fed19f84c5712d2c916de3878a1de945`，独立安装复用已接受的 #25 r3。当前集成源码为 `7553824adf2a7769e2add9c6bf9c20c06ff8f821`；144 个 build 输入、219 个 compiler 输出及 12,894 个安装文件/链接核对相符。来源归属保持原 producer，不把集成元数据提交冒充重建。

- 分发包：`/Users/nineofour/pi-durio-v1-run/evidence/issue-25/r3/pack/pi-durio-0.1.0.tgz`，SHA256 `0ba48a30a1f298f057bfc4a3f38d313a5aba8dc07fe94b8469851f87afc7cec0`。
- 源码归档、lock、compiler 输入/输出、安装明细引用见 `candidate-r2/artifact.json` 及所引用的 #25 r3 `candidate-identity.json`。
- Linux runtime 内容身份 `c728b7d90e2af4753bc2d4247622c6dcd1a3477d717eb7ff08a66390b81f527e`；Node `v24.8.0`、linux arm64；镜像 `pi-durio-eval@sha256:7cfd5ced23d374c1c17d6848c192965f3f4daa6f6f10a6e8d88ae408b559b37c`。
- 实际 synthetic seed run：`f5a2c71a-80e6-41e1-86f1-c8b23ae6a7b1`。通过独立安装的公开 `runCodingTask` 执行既有 `check.mjs`，取得真实首个 `AssertionError`。脚本 provider 只安排检查，不是推理，也不制造 improve 候选。`candidate-r2/seed-{result,records,requests}.json` 与 `improve-data` 留下原记录。
- [improve-fixture.json](improve-fixture.json) 中四个文件均与 seed 前字节一致。后续分析只登记这四个文件及该 seed；仅 `clamp.ts` 可成为写回目标，`README.md`、`package.json`、`check.mjs` 受保护。

## 已完成的必要验证

`auth-stop-r2/summary.json`：真实安装的 `runEval`、既有预算、restricted VM 和公开证据回调共同执行 synthetic 401 与 403。每种恰好一次 dispatch；错误流刻意附带可结算的 2 tokens，仍停止后续 trial；原始错误响应完整保留，后续项为 `not-run`。第一项保留 `cancelled` 和明确 HTTP 原因，不能写成真实 provider 失败或成功。403 使用同一数据根但独立 run 身份，未被此前 401 误触发。

`gate-check.json`：`paidApproved:false` 的明确负例在任何凭据 lookup、付费计划或 `paid-start.json` 写入前被拒绝；两个产品 journal 内容未变。所有脚本通过 Node syntax 检查；差异检查通过。未重跑仍适用的完整产品测试；#25 的确定性执行、选择、写回、回退和隔离证据按其原适用范围复用。

`install-set-check/summary.json`：完整比较实际安装的普通文件/链接集合及内容，额外普通模块、额外目录 symlink 均被拒绝；目录 symlink 记录其自身 path/target，不跟随。门在加载产品、凭据存在 lookup、写入 paid-start 和计划 materialization 之前。`install-gate-applicability.json` 核对认证停止函数体字节未变，seed/VM/product 输入与环境未变，因此沿用上述 VM 结果，没有重复运行。

首败保留：

1. `prepare-first.log`：准备 helper 将安装清单内 symlink 当普通 hash 比较，失败后按既有 `symlink` 字段修正；产品文件未改变。
2. `candidate-r2/query-limit-first-failure.json`：首个 proposal 的两个查询字节上限超过公开 API 允许值，未启动分析；修订 proposal 改为各 32768 并通过公开 validator。原 proposal 与精确差异均保留。
3. `auth-stop-first.log` 与 `auth-stop/report-401.json`：固定内容准备耗尽原 180 秒测试 deadline，实际 dispatch 为零。r2 新测试身份使用 900 秒测试准备期限和已有内容对象；没有改写原计划、删失败或放宽真实批次 60 分钟期限。

`helper-source-provenance.json` 区分最终冻结脚本与依据编辑记录重建的早期 helper 版本。早期 helper 并未在运行前另存 hash，不能冒充事前固定；实际产品 producer、生成计划、输入、首败和原文都有独立记录。

## 获授权后的唯一入口

协调者保留用户原授权与许可凭据来源后，提供 grant JSON。该文件的字段为 `paidApproved`、`manifestSha256`、`batchId`、`humanAuthorization`、`credentialSource`、`grantedAt` 和 `limits`；limits 必须精确包含 `maxRequests:40`、`maxTokens:4000000`、`usdCeiling:5`、`grantToStartMs:86400000`、`activeMs:3600000`、`starts:1`。当前不存在肯定 grant。不能用本说明、准备数据或设计确认代替用户决定。

```sh
node scripts/live-batch/run.mjs FROZEN_MANIFEST EXPLICIT_HUMAN_GRANT
```

入口在核对固定文件、授权、期限、安装完整文件/链接集合及内容、Linux runtime、fixture 和凭据存在后，独占写入一次 `paid-start.json`。之后才用公开 `prepareEval` 生成 `paid:true` 计划；相对已审 proposal 只允许该字段与具体 deadline 改变，并保存授权和精确差异。任何已有 start 都阻断再次运行，不因操作 ID、进程重启或终端重开重新获得预算。

401/403、请求/token/time/response 限制、未知用量无法保守约束、固定模型不可用、已知价格变更使申请额度不足、身份/所有权/隔离失效、case 必要检查失败或结果未知均停止下一项；实际候选为零、报告无效或不完整时保存并结束，不额外调用以凑出候选。存在其他范围外修复需要时返回具体事实。

真实分析后只返回实际报告。候选 revision、源证据、目标 baseline、实际拟写内容、确定性检查、保护文件、回退方法和写回范围需组成可审阅的结构化选择，交给用户决定。grant 不选择任何未知未来候选。之后才可用公开 `previewImproveDecision` / `submitImproveDecision` 执行选中范围，核对实际写回与已验证字节，并通过现有 CLI/TUI/API 只读重开。项目文件写回不冒充新 build 启用；费用以宿主阶段账本去重，不把 eval guest 的 coding 记录再加一次。

#26 后续新 build 的适用性须按实际差异另行核对，不能重标本批 producer。真实四例和 improve 闭环、#31 总体验收、#32 日用接受继续待办；不含 push/main/release/关票。

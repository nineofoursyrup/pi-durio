# #21：固定计划、预算与实际受限 eval

`pi-durio eval` 将真实 `runCodingTask`、Pi Harness、Provider adapter 和 read/write/edit/bash 放入 Apple container VM。可信宿主顺序执行固定计划，在实际 HTTP dispatch 处预留预算，停止 VM 后固定产物，再启动独立受限 grader。它复用 #12 的隔离实现和 #18 的 Evidence/fixEvidence，没有复制 agent loop，也没有新建账本。

本票验证采用确定性 transport。它证明运行、预算、隔离、证据与评分接线；不能证明模型能力或改善。真实模型四类任务属于 #30，成对改善属于 #22。

## 使用

先在 macOS arm64 安装 Apple container 1.4.1。固定镜像及 Linux 依赖准备需要明确的网络准备步骤，正式 trial 不下载依赖：

```sh
npm ci
npm run build
container build --platform linux/arm64 -t pi-durio-eval -f scripts/eval/Containerfile .
node scripts/eval/prepare-runtime.mjs /absolute/new/linux-runtime pi-durio-eval@sha256:7cfd5ced23d374c1c17d6848c192965f3f4daa6f6f10a6e8d88ae408b559b37c
node dist/src/cli.js eval plan --data-root /absolute/eval-data --spec /absolute/eval-spec.json
node dist/src/cli.js eval run --data-root /absolute/eval-data --id my-eval --directory /absolute/new/execution
node dist/src/cli.js eval report --data-root /absolute/eval-data --id my-eval --format text
node dist/src/cli.js eval report --data-root /absolute/eval-data --id my-eval
```

镜像名称不能替代内容 digest；新构建的 digest 若不同，应以经核对的新不可变镜像重新准备和固定计划。镜像准备代码、lockfile、准备输出和原镜像 OCI 归档均在本次外部证据目录中保留。

`eval-spec.json` 的最小离线示例（deadline 必须改成实际未来时间；installation 是上述已准备目录）：

```json
{
  "id": "my-eval",
  "purpose": "验证四类公开开发案例的产品接线",
  "mode": "offline",
  "installation": "/absolute/new/linux-runtime",
  "budget": {
    "maxRequests": 32,
    "maxTokens": 65536,
    "maxRequestTokens": 1024,
    "deadline": "2026-10-10T12:00:00.000Z",
    "unknownUpperBound": null
  },
  "trialTimeoutMs": 90000,
  "gradingTimeoutMs": 30000,
  "maxOutputTokens": 512
}
```

`plan` 返回全部案例、初态/dirty 内容、实际依赖与可信宿主源码引用、内容版本、顺序/身份、模型、不可变镜像、隔离源码、请求/用量/时限/重试限制和费用口径，并通过已有固定证据保存。默认包含四类公开案例。`run --id` 是对这份完整固定计划的明确执行；CLI 会在开始前把计划打印到 stderr，stdout 返回机器报告。开始过的计划只能查询，不能重启同身份；补跑须新计划和 trial ID，可用 `replaces` 指向原 trial。

TUI 输入 `/eval`，只读查看列表与报告；`e` 查看记录来源，Enter 查看原文，`n/p` 翻页，`b` 返回。它没有模型、runner 或写入能力。完整原文、provider dispatch、预算事实及固定证据也可用已有 `history`/`evidence` CLI 查询。

## 运行与信任边界

- 每次产品运行与评分均使用新 VM、新 session、新 HOME/TMPDIR/cache、独立 Git 工作树及数据根；dirty 输入在固定初态 commit 后应用。只共享固定内容的只读生产依赖。宿主 runner、fixture、答案、grader 和凭证不在 `/deps` 中。
- 受限侧只提交模型请求 JSON；宿主校验大小、结构、文本类型、允许工具、固定模型与输出上限，不信任客体 URL、key、purpose、usage 或 attempt 身份。唯一宿主 endpoint 为 `https://api.deepseek.com/chat/completions`。
- `PersistentBudget` 记录实际 dispatch 前的 reservation 和后续 settlement。普通生成、自动 compaction、SDK 重试、可选模型评分使用同一 seam；当前 retry limit 为 0，grader 为确定性 Node，故本批没有评分模型请求。请求目的采用可信阶段 `eval-runtime`，客体 compaction intent 只作诊断关联。
- 无可靠上界的 unknown usage 会阻止下一请求和下一 trial；取消不退回 reservation。live 计划要求 paid 授权、费用版本与足以覆盖固定 provider 上限的预留，运行前再次校验。输入保守上界使用 1,048,576 tokens 加显式输出上限；这不是 token 估算器。模型 alias 不证明实际服务权重身份。
- 只有 stop、stopped、delete、absence 全部核对后才导出普通文件；链接/特殊文件/不明残留不导出、不复用目录。导出总量与文件数有独立限制。外层 owner 丢失即取消 VM，拒绝新 dispatch 和证据追加；不能在未知所有权下释放或继续运行。
- 产品 outcome 与 grader judgment 分开。必要条件得到可判定反例时 FAIL；grader 崩溃、超时、取消或证据缺失为 unknown。追加重评分保存新 grader 版本与隔离源码，不修改 outcome 或首败。

## 报告口径

`N` 计划、`B` 启动、`C` 正常完成、`G` 有效且可判定的评分、`S` 通过。通过率为 `S/G`，完成率为 `C/N`，覆盖率为 `G/N`；分母为零返回 null/N/A。错误、未运行、旧评分和首败都仍可见。正式评分仅计入 valid outcome；尚未固定或 missing/corrupt evidence 会移出有效集合，并保留历史判断。

费用只从宿主实际 reservation/settlement 计算；输出全部 side、失败请求和 missing 数量，unknown 不伪装为零总费用。价格是计划固定的每百万 token 估算口径，离线 transport 为零费用来源。准备、任务、评分采用宿主单调时钟；显式镜像/Linux 安装准备在独立日志中，不含在 eval execution time 中。

`eval grade --spec REVISION.json --directory NEW_DIRECTORY` 只对固定产物追加评分。revision 包含新的 `revisionId` 与按 case ID 映射的完整 grader（version/program/expectedStdout/required）。同名 revision 不覆盖；它不重新运行任务。

## 本次验收与首败

本次全部原始文件保存在 `/Users/nineofour/pi-durio-v1-run/evidence/issue-21`，版本与复核入口见同目录的 `acceptance.json` 及仓库内 `acceptance.json`。

- 首轮实际 VM：四类完成，必要条件失败 FAIL、grader 崩溃 unknown；实际产品工具探测宿主路径、评分资产、共享 Git、网络、宿主进程/socket、只读依赖；子进程继承限制且停止 VM 后 heartbeat 不再变化；独立受限 grader 再测边界。
- 预算仅 1 个请求、unknown usage、服务故障、自动 compaction 2 个请求上限均阻断后续请求，保留尚未运行项。自动 compaction 来自真实上游产品调用，而非伪造 purpose 的计数测试。
- 原文写入故障发生于已进入产品 runtime 的受控 trial，保留 `original-error`，`G=0`。不明/不安全导出保留原始结果并拒绝正式评分。
- 早期准备失败分别为固定镜像缺 Git、Linux 挂载边界上的非 Git 初态诊断；两次失败仍保留，基础设施失败不计为有效产品评分。第一条早期误计的结果通过追加 applicability 修正，没有改写原 outcome/FAIL。
- 首轮 no-change 只验证文件与功能，未覆盖要求的解释；历史 PASS 保留并追加 unknown。补充案例明确要求结构化分析答案，新的独立检查同时验证回答和无修改，使用新身份运行。

这里的运行证据不替代 macOS Terminal 的完整 TUI 原生验收，也不替代 #30 的付费 provider 实测。不要把准备通过、机制探测通过或公开确定性脚本通过表述成模型结果。

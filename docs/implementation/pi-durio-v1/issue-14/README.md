# #14：中止与退出的可解释收尾

范围为 `PI-DURIO-V1-TICKETS-r1:T04` / `PI-DURIO-V1-SPEC-r1` R2、R4、R7、E3–E6。沿用 #3/#5/#8 完整合同与 ADR-0001/0002；没有重写 agent loop 或恢复状态机，没有新增付费 provider、自动续跑、外部回滚或所有后代已停止的承诺。

## 行为与接口

`runReadTask`、`runCodingTask` 及其 `signal`、`cancellation` getter、`onObservation` 保持兼容。首次 abort 在第一个异步步骤之前锁定 `stop` 或 `exit`；初始化、受理和清理期间后续 getter 变化不改写它。收到请求先停止受理/放行并持久保存 `run.abort-intent` 或 `run.exit-intent`、`lifecycle.processing`，再请求真实清理。模型 transport 和 shell 最后放行前再次检查，持久记录/观察回调内收到取消也不能继续启动该操作。

- `stop` 调用公开 `Conversation.abort()` 持久化 durable 中止；确认终止的工作不会变成普通 pending。
- `exit` 调用公开 `Harness.close()`，保留未完成 durable 工作；返回既有 `status: unknown`，新增 `lifecycle.disposition: resumable` 表明可供后续恢复核对的未完成工作，不代表允许立即执行。
- 正常结果已进入最终收尾后，迟到取消不把已完成结果改写成中止。
- `waitForRun(runPromise, signal?)` 复用 Chord 的 `awaitWithContext`，取消只使该等待者 reject，不取消工作、不新增请求/费用，也不触发另一轮调度。

可选 `cleanupTimeoutMs` 是宿主等待策略，默认 10000，允许 1–300000 ms，实际值保存于 `execution.config` 和结果。它不是给模型扩展权限的入口，也不是外部停止期限。deadline 到达或 abort/close 失败时 `status/cleanup` 为 `unknown`，保留 owner 与核验责任。迟到响应、工具输出和关闭结果仍可写入原记录；只在真实关闭完成后关宿主 evidence，不因等待者超时提前关在用存储。迟到完成追加 `lifecycle.late-close`，不提升先前 unknown，也不自动释放 owner。

CLI `run` 接受 `--cleanup-timeout-ms N`；SIGINT 表示停止任务，SIGTERM 表示退出，首次意图保留。处理中消息写 stderr，最终 JSON 写 stdout。headless 清理不能确认时，在 flush JSON 后退出 75，避免不响应取消的 active handle 使应用无限挂起；这只结束宿主进程，不宣称残留命令/远程副作用已停止。正常/中止/需核对/失败沿用退出码 0/130/75/1。取消不退款、不回滚已经写入的文件。

## 清理、存储和 owner

顺序为停止宿主放行 → stop 所需的 durable abort → Harness 取消并等待受管执行 → durable storage close → 持 owner 读取关闭快照 → 保存宿主收尾记录并关 host storage → session/workspace/data-root owner 释放。初始化期间已经领取 session owner 时，完成该已受理空存储的分配后关闭；不会为了收尾开启调度。

`NodeExecutionEnv.exec()` 的真实返回与 started/settled 数量、storage close 和 owner heartbeat 分开观察。保存所有已经取得的输出、返回与原失败。`Harness.close()` 或 PID 不存在都不能独立证明外部效果已停止，结果继续带 `externalProcesses/remoteTermination: unknown`。长期命令及普通子进程测试结合公开 exec 返回、实际目标停止增长和进程检查，PID 检查仅是辅助。崩溃演示亲见宿主 SIGKILL 后残留子进程继续写实际文件，保留 unknown 和重开核验责任。

`proper-lockfile` 在进程退出时可能移除 `.lock` 目录；现在 `.lock` 与 `owner.json` 任一存在都阻止自动取得所有权。正常 release 先释放库锁，再删除自身 owner marker；未知、崩溃、owner 丢失保留 marker。workspace registry 对该持久标记同样检查，所以改 dataRoot 也不能绕过同工作区的未知执行。不能按 PID 消失、超时或一次迟到 close 自动夺锁；人工处置/跨重启恢复仍由 #15 承接。

`run.closed.lifecycle.owner: release-after-host-close` 表示该记录保存后即执行的释放顺序，并非记录时所有 owner 已释放的断言。`retained` 则明确不走自动 release。host 记录与 owner marker/上游存储不是跨资源原子事务；记录失败保留原文缺口，不编造完成回执。

## 追加事实

保持 host `records` schema、BlobRef、`readRun/readObject` 与旧 `RunResult` 必需字段。新增可选 `lifecycle` 包含 intent、disposition、cleanupTimeoutMs、storage、owner 和 remoteTermination。

| 记录 | 含义 |
| --- | --- |
| `lifecycle.processing` | 已处理首次 stop/exit；宿主受理与放行已关闭 |
| `lifecycle.abort-started/abort-settled/abort-failed` | 公开 durable abort 的真实阶段或失败 |
| `lifecycle.close-started` | 请求 Harness/storage close |
| `lifecycle.storage-closing/storage-closed` | 真实 storage close 边界及当时受管命令数量 |
| `lifecycle.timeout/close-failed/owner-lost` | 无法确认收尾，owner 保留、需核验 |
| `lifecycle.late-close/late-close-failed` | deadline 后发生的真实关闭事实；原 unknown 不变 |

已取得 provider/tool 原文、actual attempt、原 usage 及已提交 `pi.usage` 留在既有记录。未得到或无法确认提交的 usage 保持 unknown/partial，不能因取消算零。查询只读，不开 Harness、不重发工具/模型、不重新记账。pending/未知仍在 preflight 阻断，未增加恢复入口。

## 验证与交接

项目检查：`npm run check`。独立演示：`node scripts/demo-lifecycle.mjs /absolute/evidence/directory`。仅使用显式 offline transport 驱动真实公开 Pi Harness/provider adapter/工具/SQLite/命令；该 transport 不做模型推理，也不是实际产物的正确性 oracle。演示覆盖正常子进程、中止、退出、命令超时原失败、部分流、取消等待、真实 host 崩溃与残留效果、headless cleanup 超时与活跃 handle；用独立进程重开并比较数据根内容 hash。

实际日志、fixture、记录和工件位于 `/Users/nineofour/pi-durio-v1-run/evidence/issue-14/`；精确 candidate、检查和要求索引见 [validation.json](validation.json)，首败链见 [first-failures.md](first-failures.md)。代码已合并当时最新 integration；#16 的 TUI/headless 组合检查和真实 macOS Terminal 人工接受分别记录，不改变固定 r3 Terminal 测试安装。

真实 DeepSeek 推理/认证/计费 NOT RUN；无付费授权。恢复核对与明确继续由 #15 承接。#16 真实 Terminal 人工门槛、完整首版验收、日用接受、push、main 合并、关票及发布未在本票完成。

一手 API：精确发布构建的 [Harness](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/harness/harness.ts)、[README](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/README.md)、[NodeExecutionEnv](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/env/node.ts)，并核对本次安装的精确 npm 1.1.0 dist 代码。取消等待及 abort/close 均调用上游公开接口。

# #17 恢复启动 WIDTH_CPR_TIMEOUT 修复

状态：本地回归通过；修复后的原生冷重开和实际新任务执行待新候选补测。原 `candidate-r1`、两次人工记录及其 FAIL/UNKNOWN 保持不变。无付费 provider、push、main merge、release 或关闭票。

## 原因与红绿闭环

`ReadOnlyTui.start()` 同时启动字宽校准和 `openRecovery()`。恢复核对经 `checkRecovery()` 验证原执行材料；其 `verifyArtifact()` 会同步读取、散列当前安装的文件。同步核验与带 1200ms deadline 的 CPR 查询重叠时，即使终端已经回答，Node 也可能在处理管道中的回答之前处理过期 timer。

复现命令：`node --test dist/test/tui-recovery-start.test.js`。测试建立独立真实 offline 中断 run，从实际 `app.start({runId})` 或 `/recover` 进入核对，在实际执行材料读取处施加一次 1400ms 同步延迟，随后仍调用原 `readFileSync` 完成正常核验。独立子进程经真实 pipe 回答 CPR/DA1；没有手工抛出 timeout、mock `checkRecovery()`、普通打开旧人工 Harness 或修改人工证据。

外部证据根：`/Users/nineofour/pi-durio-v1-run/evidence/issue-17/reopen-repair/`。

- `first-red.log`：原实现 0/1，核验延迟 1405ms，核验开始时 1 个查询在途，出现与现场相同的 `Display unverified: Error: WIDTH_CPR_TIMEOUT. Ctrl+L retry; Ctrl+C twice exit.`。
- `first-green.log`：同一启动回归 1/1，延迟 1405ms，核验开始时在途查询 0，恢复面板无需 Ctrl+L 直接显示。
- `affected-checks.log`：30/30，包含启动、`/recover`、width、TUI 和 control facts。真实缺失回复仍然触发 timeout；DA1 未完成时 Ctrl+L 仍拒绝重用，迟到边界完成后重试成功。
- `source-runner-check/prepare.log`：新短补测脚本经真实 public offline coding runtime / TaskControl 准备出 aborted/confirmed 源和 frozen follow-up / compact；仅 headless 准备，原生 NOT RUN。

现场 3.232 秒回包间隔与该竞态一致。回归证明的是这条可复现的调度缺陷及修复；修复后真实 Apple Terminal 的冷重开仍需独立观察。

## 最小改动

宿主 width gate 增加 `withoutQueries()`：先持有输入/画面并等已启动校准结束，再执行恢复核验；核验结束后测量所需字符并重绘。启动在首轮测量前持有该边界；`/recover` 复用同一入口。检查期间显示 ASCII loading 提示，优先退出/取消键及未应用输入保留沿用既有机制。关闭之后不再启动核验或新测量。

1200ms deadline、CPR/DA1 顺序与 tombstone、Pi 包与补丁、运行/队列/恢复 core、stop/exit 目标和决定语义均未改。既有 #16 原生 IME/复制/宽字符/退出证据，以及 #17 已通过 queue-stop/只读限制等仅按不变路径适用性继承，不标成新候选新测。

## 最短原生补测

新 `scripts/recovery-start-terminal-validation.mjs` 绑定新候选的完整安装文件集、runner、manifest 和 source commit。每次调用创建独立目录，真实 offline runtime 做 headless fixture 准备，然后只要求以下原生动作：

1. Enter 冷重开，恢复面板应直接出现，不需要 Ctrl+L。
2. 按 `e` 结束旧工作；等待 `ended`。
3. 输入 `全新任务` 并按 Enter；等待已完成。
4. `/queue` 检查原 follow-up 与 compact 两项仍冻结，Esc 返回。
5. `/exit` 退出，记录 P/F/U 与可直接紧接的中文说明。

机器单独核对 cold-start 无 timeout/无需 retry、测宽成功、原状态保留、旧工作明确结束、新 task 实际完成、新 provider 请求只含新任务且未消费旧队列、raw/stty 恢复。人类 P 不能覆盖机器缺口。`F启动时...` 与 `F 启动时...` 均记 FAIL，原答复永久保留；旧 r1 的评分字段不重写。

r1 第二阶段已确认的 readonly/end/frozen 事实与新任务未实际输入的缺口分别保留。新补测必须有实际 `全新任务` 受理/完成，不能仅凭人工主观判断补齐。

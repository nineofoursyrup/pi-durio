# 本机试用：技术验收完成，日用接受待确认

#11–#31 的技术范围已由协调接受；[#32](https://github.com/nineofoursyrup/pi-durio/issues/32) 留给你在自己的 Mac 实际使用后决定。当前可用产品是 `f26ae8f4b8039608a1fa796e1c69da4d8173d112`，已独立安装，无需重新安装。后续文档提交不改变这份已验证的可执行候选。

[技术接受结论](../issue-31/TECHNICAL-ACCEPTANCE.md)与[独立 Standards / Spec PASS](../review/final-technical-f26ae8f/review.md)是当前状态；原[技术报告](../issue-31/final-f26ae8f/REPORT.md)内的“待独立审查”保留其生成时事实。[91 行证据索引](../issue-31/final-f26ae8f/contract-evidence-index.md)提供完整合同、ACC 与 MET 的适用证据，行数不表示独立测试次数。

## 在 Apple Terminal 开始

下面是**零费用 offline 交互演示**：使用固定响应、0 provider 请求、没有模型推理。它让你操作输入、查看记录和退出，不能证明真实 coding 能力，也不会自动取得日用接受。

在 macOS 的“终端 / Terminal.app”粘贴：

```sh
/opt/homebrew/Cellar/node/26.8.2/bin/node \
  /Users/nineofour/pi-durio-v1-run/evidence/final-candidate-f26ae8f/install/node_modules/pi-durio/dist/src/cli.js tui \
  --workspace /Users/nineofour/Durio/test/fixtures/project \
  --data-root "$HOME/Library/Application Support/pi-durio-f26-user-trial-demo" \
  --offline-demo
```

输入 `Read README.md` 并按 Enter；完成后可输入 `/history` 查看记录，Esc 返回，`/exit` 退出。`/help` 或 F2 查看操作；忙时 Enter 补充当前任务，Ctrl+X 后 Enter 排后续请求。运行中 Ctrl+C 请求中止并等待清理；中止或退出不会撤回已发生的文件变化或费用。

你也可以自行选择信任的项目和实际任务试用。下面的真实 coding 入口需把 `/absolute/my-project` 替换成自己的项目绝对路径，并在自己的 Terminal 环境准备好 `DEEPSEEK_API_KEY`；不要把凭据粘贴到聊天或报告。**提交任务会向 `deepseek/deepseek-flash` 发出可能计费的请求。** `--coding` 允许 read/write/edit/bash；普通 coding 是可信本机执行，不是 OS 沙箱。

```sh
/opt/homebrew/Cellar/node/26.8.2/bin/node \
  /Users/nineofour/pi-durio-v1-run/evidence/final-candidate-f26ae8f/install/node_modules/pi-durio/dist/src/cli.js tui \
  --workspace /absolute/my-project \
  --data-root "$HOME/Library/Application Support/pi-durio-f26-user-trial" \
  --coding
```

这是供你自己选择和启动的使用入口。既有代理付费批次的授权均已消费；若要由 agent 再启动付费批次，仍须另行明确该批次的范围与预算。本票不要求重复付费验收，也没有新增问卷、最低试用时长或自动通过门槛。

## 记录与恢复

演示和真实使用的数据根分开，均在项目外；不要使用验收原件目录作为日用数据根。`/history` 查看本次数据根的历史。退出输出中的 `runId` 可用于只读查看原文和恢复事实；完整的 `history`、`show --originals`、`recover --inspect` 命令见[启动与恢复说明](../issue-31/final-f26ae8f/STARTUP-RECOVERY.md)。把该说明中的数据根与 run ID 换成本次实际值。

遇到旧 pending、owner、未知副作用或版本不兼容，先查看恢复事实；`tui --run RUN_UUID` 打开恢复面板，不自动继续。继续、结束旧工作与确认清理分别需要绑定报告身份的决定。保留原文和锁，不用删除它们绕过检查；新任务不会自动接入旧冻结队列。原文默认完整保留、未加密；归档或迁移保留源，清理另需 preview 和明确 commit。

## 已测资源与限制

供试用的机器环境已只读核对为 macOS `27.2 (26B5101f)`、`arm64 / MacBookPro18,1`、32 GiB RAM、Node `v26.8.2`，已安装 Apple Terminal `2.15 / 488.7`。这是准备时机器事实；你的实际试用环境、窗口、profile、字体及任务尚待取得，不把旧测量窗口当作本次事实。

| 项目 | 当前候选已有测量 |
| --- | ---: |
| 自有产品源码 | 80 文件 / 7,531 物理行 |
| 压缩分发包 / 完整独立安装 | 19,222,769 / 90,158,076 logical bytes |
| 帮助命令新进程启动 | 7 次，中位数 212.937 ms |
| 原生空闲 Node RSS | 3 次各至少 30 秒；各次中位数 90.406 / 89.500 / 90.016 MiB |
| 原生 62 任务会话 Node RSS | 中位数 280.859 MiB，采样峰值 289.656 MiB |
| 该会话保留原文的逻辑增长 | 42,099,297 bytes |

完整查询/导出测量与口径见[当前原生报告](../issue-31/final-f26ae8f/NATIVE-REPORT.md)。安装体积含依赖/vendor、不含外部 Node；启动未清系统缓存；RSS 仅宿主 Node 采样，不含 Terminal.app/子进程，不证明小时级稳定性。数据增长包括完整原文保留，不直接等于泄漏；这些数值没有预设“轻量通过”阈值。

- 已验证的独立安装可直接使用。npm `11.19.1` 下 bundled `file:` 依赖的 `npm ls` invalid 与消费端离线 `npm ci` FAIL 仍是已知安装路径限制，见[安装诊断](../delivery-9aed1af/npm-diagnosis-REPORT.md)；不要据此重装现成入口。
- 当前原生自动测量与恢复通过；历史人工 IME、emoji、复制、小窗口等只按记录的场景和未变代码/依赖限定复用，profile/字体 UNKNOWN 保留，详见[适用性说明](../issue-31/final-f26ae8f/reconciliation-preparation.md)。自动输入不代替你本次的实际操作。
- 真实模型及 improve 的首败和 UNKNOWN 均保留。累计 45 次物理请求、130,611 known tokens 加 1,056,768 UNKNOWN 预留；占额估算 USD 1.4248548 是历史保守估计，不是账单或本次预算。效果边界、分项与未能分离的耗时见[技术报告](../issue-31/final-f26ae8f/REPORT.md)。

## 试用后的决定

实际使用后，你可以直接回复 **“日用接受”**，或 **“先修正：<具体问题>”**。协调会依据实际使用入口/记录和你的直接回复，追加实际候选、环境、原始反馈来源及时间；没有证据的字段继续待取得，见 [pending-acceptance.json](pending-acceptance.json)。

沉默、设计确认、技术测试通过、修正计划或普通感谢都不推定接受。要求先修正时继续待接受，保留原反馈、候选和首次失败，取得相关修复授权并完成必要复测后，再由你明确决定。全部必要技术证据仍适用且明确日用接受同时成立，才记录首版完成；付费、Git 操作、main 合并和发布各自保留授权边界，#32 不自动关闭或修改父规格 #10 / Map #1。

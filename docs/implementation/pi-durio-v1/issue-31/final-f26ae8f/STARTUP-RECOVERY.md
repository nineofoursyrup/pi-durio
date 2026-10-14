# 固定候选启动、配置与恢复

本说明对应候选 `f26ae8f4b8039608a1fa796e1c69da4d8173d112` 的已核对独立安装。当前 #31 技术证据已齐，待独立审查及协调验收；#32 日用接受仍待用户。不要将下面的手动使用说明理解为重跑旧付费批次的授权。

## 查看与启动

在 macOS Terminal 使用已固定 Node 和安装入口查看帮助：

```sh
/opt/homebrew/Cellar/node/26.8.2/bin/node   /Users/nineofour/pi-durio-v1-run/evidence/final-candidate-f26ae8f/install/node_modules/pi-durio/dist/src/cli.js --help
```

只读离线演示使用新的数据根（须在项目外）：

```sh
/opt/homebrew/Cellar/node/26.8.2/bin/node   /Users/nineofour/pi-durio-v1-run/evidence/final-candidate-f26ae8f/install/node_modules/pi-durio/dist/src/cli.js tui   --workspace /Users/nineofour/Durio/test/fixtures/project   --data-root "$HOME/Library/Application Support/pi-durio-f26-demo"   --offline-demo
```

`--offline-demo` 无网络/模型推理；输入 `Read README.md` 可运行固定演示。用户自己的项目路径与数据根由实际用途决定；不要把验收原件目录当作新日用数据根。源码目录的 `npm ci` 与分发包的离线 `npm install` 是不同路径，当前安装无需重装。

真实任务默认 `deepseek/deepseek-flash`，认证来自 `DEEPSEEK_API_KEY`。去掉 `--offline-demo` 并提交任务会发出可能计费的请求。已有真实批次的一次授权均已消费；本次报告没有发起新请求。此处不读取、不回显 `api.env` 内容。

`run`/`tui` 默认只提供 `read`；对明确项目加入 `--coding` 才开放 `read/write/edit/bash`。普通 coding 是可信本机执行，工作区锁不提供 OS 沙箱。`--tool-env-config PATH` 可显式提供 `{ "version": "project-v1", "variables": { "PROJECT_MODE": "test" } }`；记录名称/版本，不保存配置值，模型 key 不默认传给工具。

## 操作与退出

空闲 Enter 提交；忙时 Enter 补充当前任务，Ctrl+X 后 Enter 排后续请求。`/queue`、`/history`、`/bottom`、`/help` 和 F2 提供查看入口。运行中 Ctrl+C 请求中止并等待清理；空闲优先 `/exit`。退出不撤回文件变化、已发生费用或自动解除旧队列冻结。

## 只读重开与恢复

将下面的 `/absolute/data-root` 与 `RUN_UUID` 换为要核对的真实记录身份；示例不触发重跑：

```sh
/opt/homebrew/Cellar/node/26.8.2/bin/node   /Users/nineofour/pi-durio-v1-run/evidence/final-candidate-f26ae8f/install/node_modules/pi-durio/dist/src/cli.js   history --data-root /absolute/data-root --format json
/opt/homebrew/Cellar/node/26.8.2/bin/node   /Users/nineofour/pi-durio-v1-run/evidence/final-candidate-f26ae8f/install/node_modules/pi-durio/dist/src/cli.js   show --data-root /absolute/data-root --run RUN_UUID --originals --limit 20
/opt/homebrew/Cellar/node/26.8.2/bin/node   /Users/nineofour/pi-durio-v1-run/evidence/final-candidate-f26ae8f/install/node_modules/pi-durio/dist/src/cli.js   recover --data-root /absolute/data-root --run RUN_UUID --inspect
```

`host.sqlite` 保存宿主事实，`sessions/` 保存 durable 状态，`objects/` 保存完整取得的原文。旧 pending、owner、未知副作用或版本不兼容时先读恢复报告。普通 `recover` 会保存报告，需要决定时非零退出；继续/结束/确认清理由绑定报告身份的结构化决定触发。TUI `--run RUN_UUID` 打开恢复事实，关面板不会解除限制。不得删除锁或原文绕过检查；新任务不自动接入旧冻结队列。接口细节见[恢复说明](../../issue-15/README.md)。

原文默认保留且未加密；归档/迁移保留源，清理另需 preview 和明确 commit。用户选候选、受限验证、精确写回、后续实际生效、日用接受分别保留事实，完成一次 improve 不等于日用接受。

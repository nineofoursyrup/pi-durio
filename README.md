# pi-durio

面向 macOS arm64 / Node >=22.19.0 的本地 coding agent，复用 Pi runtime，保留运行原文，并由用户明确控制恢复、eval 和 improve。

首版仍在实现中。[22 票状态与证据](docs/implementation/pi-durio-v1/status.md)和 [integration Draft PR #33](https://github.com/nineofoursyrup/pi-durio/pull/33)记录当前范围；真实 DeepSeek 批次、完整技术验收和本机日用接受尚未完成。[局部本地测量](docs/implementation/pi-durio-v1/issue-31/local-r1-report.md)保留固定旧候选的体积与进程启动数据；评审发现的启动内存和批次取消问题正在修复。

## 安装与本地演示

在源码目录安装锁定依赖并检查：

```sh
npm ci
npm run check
node dist/src/cli.js --help
```

在 macOS Terminal 启动只读离线演示：

```sh
node dist/src/cli.js tui --workspace "$PWD/test/fixtures/project" \
  --data-root "$HOME/Library/Application Support/pi-durio-demo" --offline-demo
```

输入 `Read README.md` 后按 Enter。`--offline-demo` 使用固定 HTTP/SSE 响应，实际运行 Pi 适配器、Harness、工具和持久记录；不进行网络调用或模型推理，也不用于判断模型能力。无终端时可使用相同的 headless 入口：

```sh
node dist/src/cli.js run --workspace "$PWD/test/fixtures/project" \
  --data-root "$HOME/Library/Application Support/pi-durio-demo" \
  --prompt 'Read README.md' --offline-demo
```

`npm pack` 生成包含锁定生产依赖的分发包，供当前 macOS arm64 目标独立安装；Node 本身不打包。各票的已验证安装有自己的源码、构建、依赖与包身份，最新源码状态不能自动替代这些身份。

## 真实 coding 与终端操作

默认 provider 为 `deepseek/deepseek-flash`，地址为 `https://api.deepseek.com`，认证从 `DEEPSEEK_API_KEY` 读取。**去掉 `--offline-demo` 后，提交任务会发出可能计费的请求。** 本轮实现的真实批次仍需[固定计划与单独授权](docs/implementation/pi-durio-v1/issue-30/README.md)；缺凭据或认证失败不会静默切换 provider。

`run` / `tui` 默认只提供 `read`。为明确指定的项目和任务加入 `--coding`，才开放 `read/write/edit/bash`。普通 coding 是可信本机执行，没有 OS 沙箱保证；工作区锁防止本产品内部重叠写入，不能隔离外部编辑器或其他本机程序。文件工具当前支持最多 256 KiB，普通任务最多 8 次 provider 尝试，输入最多 32 KiB。

TUI 使用全屏单列布局。空闲时 Enter 提交新任务；忙时 Enter 补充当前任务，Ctrl+X 后 Enter 排后续请求。`/queue` 查看队列，`/history` 查看历史，`/bottom` 回到当前任务。`/help` 和 F2 菜单列出可用操作。

运行中 Ctrl+C 请求中止，等待实际清理；空闲退出优先使用 `/exit`。双击 Ctrl+C / Ctrl+D 受当前草稿、面板和确认窗口约束。中止和退出不会撤销文件变化或已发生的费用，未接入队列保留并冻结。

## 原文、重开与恢复

数据根必须在项目外。`host.sqlite` 保存宿主事实，`sessions/` 保存上游 durable 状态，`objects/` 保存取得的原文和工件。原文没有默认清理，权限限制为当前用户读取，未加密。上下文压缩保留磁盘原文；`/compact` 与 `compact` 记录摘要生成和实际接入。

以下命令只读查看指定任务，不自动重跑：

```sh
node dist/src/cli.js show --data-root /absolute/data-root --run RUN_UUID
node dist/src/cli.js show --data-root /absolute/data-root --run RUN_UUID --originals --limit 20
node dist/src/cli.js recover --data-root /absolute/data-root --run RUN_UUID --inspect
node dist/src/cli.js history --data-root /absolute/data-root --format json
```

遇到旧 pending、遗留 owner、未知副作用或版本不兼容时，先查看恢复报告。普通 `recover` 保存报告并在需要决定时返回非零退出码；实际继续、结束旧工作或确认清理由绑定报告身份的结构化决定触发。TUI 的 `--run RUN_UUID` 打开恢复事实，关闭面板不会解除限制。不要通过删除锁或原文绕过核对。[恢复接口与限制](docs/implementation/pi-durio-v1/issue-15/README.md)。

## eval、improve 与报告

- **eval**：先固定案例、工件、评分资产、顺序、预算与期限，再在验证过的受限环境执行和独立评分；普通本机试跑仅提供诊断证据。[固定计划](docs/implementation/pi-durio-v1/issue-21/README.md) · [fresh 对照](docs/implementation/pi-durio-v1/issue-22/README.md)。
- **improve**：显式请求受限分析，候选默认不选；用户逐项选择“执行已声明范围”或“仅验证”，核对汇总后提交。自然语言意见和分析完成不构成写入授权。[分析](docs/implementation/pi-durio-v1/issue-23/README.md) · [结构化选择](docs/implementation/pi-durio-v1/issue-24/README.md) · [精确写回、后续任务配置与回退](docs/implementation/pi-durio-v1/issue-25/README.md)。[注册源码、新构建与独立 eval 资产](docs/implementation/pi-durio-v1/issue-26/README.md)分别保留验证、写回、后续入口和实际新进程事实，旧 pending 不热迁移。
- **报告**：`metrics`、`operations`、`feedback-report` 分别显示任务验收、全样本成本与故障、人工介入与返工；`completed` 只表示运行结束，不等于需求通过或用户接受。[验收口径](docs/implementation/pi-durio-v1/issue-27/README.md) · [成本/故障](docs/implementation/pi-durio-v1/issue-28/README.md) · [介入/返工](docs/implementation/pi-durio-v1/issue-29/README.md)。
- **记录管理**：历史、原文分页、trace、用量与固定证据使用同一只读查询接口。归档和迁移保留源数据，清理另需 preview 和明确 commit，受引用保护的材料不能静默删掉。[查询](docs/implementation/pi-durio-v1/issue-18/README.md) · [存储管理](docs/implementation/pi-durio-v1/issue-20/README.md)。

可用 `--tool-env-config PATH` 为 coding 显式声明 `{ "version": "project-v1", "variables": { "PROJECT_MODE": "test" } }`。配置记录保存名称及版本，不保存值；shell 不继承整个宿主环境，模型 API Key 不默认进入工具进程。

具体 JSON 请求格式和已知边界以对应入口说明及 `--help` 为准。合成 transport、静态检查和本地机制验证均有明确适用范围，不代替真实模型、用户日用接受、main 合并或发布。

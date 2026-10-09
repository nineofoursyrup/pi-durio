# #16：全屏只读 TUI（真实 Terminal 验收待完成）

实现状态为 **PARTIAL / Terminal acceptance BLOCKED**，不是 #16 整票通过，也不解除 #17/#32 的依赖。`@earendil-works/pi-tui@1.1.0` 已从当前官方 npm registry 核对、精确安装并纳入 lock 与生产打包。使用公开 `Editor`、`TuiAltScreen`、`ScrollView`、`MouseRegion`、`VStack` 与 `ProcessTerminal`；没有私有 demo 导入、fork 或 UI 持有 Harness。

## 运行

```sh
npm ci
npm run check
node dist/src/cli.js tui --workspace /absolute/project --data-root /absolute/data --offline-demo
```

`--offline-demo` 读取目标项目的 `README.md`，使用真实共用 runtime 与固定 provider transport，没有网络或模型推理。省略该参数才使用已配置的真实 DeepSeek；本票没有真实付费调用授权，相关验收为 NOT RUN。TUI 始终使用 `runReadTask`，没有可写 coding、恢复执行或忙时队列入口。忙时 Enter 保留未受理草稿并明确提示；不会把它延迟执行。

底部输入固定，显示真实工作区、会话前缀、模型配置、执行状态和已知/部分/未知用量；费用是 USD 估算。会话只显示“你 / 助手 / 读取 + 状态、失败或源截断”等自然标签；有界窗口最多读取 24 条事实后合并流片段，最终回答替换同一次流式预览，不重复呈现。工具摘要最多 500 字，回答预览最多 4000 字；记录种类、seq、JSON 和 attemptId 只在详情内。`/older`、`/newer` 翻持久记录窗口，PageUp/PageDown 或鼠标滚动；上滚后保持当前窗口与草稿，`/bottom` 恢复跟随。Ctrl+O 或点击记录打开原文 JSON 详情；n/p 每次读取约 2 KiB，左右切记录、上下滚动、y 复制当前片段。窗口读取与详情操作不写执行事实或计量。

`src/query.ts` 是共用只读宿主查询边界：`readRunRecords` 仅返回元数据与 `BlobRef`，不打开 Harness 或 writable storage；`readObjectRange` 在同一次完整流式 hash/长度校验中取得有界片段，拒绝损坏；`readTextPage` 对连续翻页保持普通 UTF-8/字符簇边界。没有把 SQLite 读取散入 TUI。旧 `readRun` 行为保持兼容。

`tool.summary` 消费器接受 #13 的有界派生摘要；失败和上游源截断可在折叠时显示，原始结果仍在 `tool.result`。#13 已在 merge 11f1e7a 合入；实际 read 大文件截断与图片不支持失败均在折叠状态显示，并通过真实 Harness 行为测试。若派生摘要缺失仍显示 unknown，不能把未报告截断当成完整。`显示截断`、`未完成的响应`、`原文不可取得` 分别标记；运行结束只来自 runtime 的结果。

## 输入与退出

- F2 或点击顶部菜单可在保留草稿时选择操作；菜单 Tab/方向键/Enter 导航，Esc 关闭并消费，不中止底层工作。
- Shift+Enter / Ctrl+J / 反斜杠后 Enter 换行。按键编码与 IME 候选行为仍须真实 Terminal 验证。
- Ctrl+D 在非空编辑区向前删除一个字符簇；屏幕拖选用于复制，沿用上游公开组件。空输入 800ms 内两次 Ctrl+D 请求退出，其他按键、鼠标、焦点或尺寸变化使确认失效。
- 运行中 Ctrl+C/Esc 请求受控中止，等待实际清理；停止/退出中连按不构成额外同意。空闲 Ctrl+C 清空并保留草稿，800ms 内再次同键请求退出。`/restore` 恢复草稿，不执行。
- F2 → exit 提供有草稿的退出选择；`/exit` 为命令入口。退出、SIGTERM/SIGHUP 和可捕获故障等待 runtime 关闭，使用公开 `stop({preserveScreen:true})` 返回原缓冲区；宿主只打印有界身份摘要。
- 草稿作为 UI 文本保存在用户数据目录的 `ui-drafts`，0700/0600，独立于任务事实。不同 UI 实例保存不同文件，不作为已受理任务或恢复授权。

40 × 12 是当前布局的**待实测建议值**，不是通过验收的最小字符格。更小窗口显示明确提示，仍可受控停止/退出；真实可用最小值由 Terminal 观察记录。

SIGKILL、掉电等无法执行自动清理。回到 Terminal 后可输入以下命令（若看不见输入，仍可键入后按 Enter），必要时新开 Terminal 标签页：

```sh
stty sane
printf '\033[?1000l\033[?1002l\033[?1003l\033[?1006l\033[?1004l\033[?2004l\033[?25h\033[?7h\033[?1049l'
reset
```

这只恢复终端显示与输入，不处理未完成 runtime 工作，也不授权重跑。

## 验证与实际限制

`npm run check` 覆盖既有 runtime 检查、元数据/原文分页及损坏拒绝、只读文件身份、字符簇编辑、多行与粘贴、草稿、弹层消费、800ms 确认和上下文失效，以及实际 Harness 在途取消/退出等待和结果 unknown。合成 `Terminal` 接口测试只证明代码行为，不证明 macOS Terminal 的 IME、字体、鼠标、系统剪贴板或原缓冲区恢复。

2026-10-09，实际调用 `mcp__cua_repl.js` 的 `cua.getApp("Terminal")` 返回：

> Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons.

该安全拒绝阻止自动操作 Terminal；没有改用 AppleScript 或另一工具绕过。真实 Terminal 验收项继续 BLOCKED，原始拒绝保存于外部证据目录。原型和合成 PTY 不用作替代证据。

`scripts/terminal-validation.mjs` 是供使用者在实际 Terminal.app 启动的候选验收入口，不控制 Terminal.app、不合成键盘输入。它先核对固定安装候选全部文件与 runner hash，然后分正常、Ctrl+C、Esc、退出和可捕获故障五个场景运行实际 TUI。自动保存环境、原始 ANSI、输入/resize、复制后 pbpaste 对照、raw/stty 前后、运行结果与同一 run 的 headless 读回。IME/字符格/视觉恢复由操作者单独报告，不自动填写 PASS。每次新建证据目录和独立数据根，保留第一次失败。具体 manifest 与复制启动命令由候选交接记录提供。

完整日志及独立候选位于 `/Users/nineofour/pi-durio-v1-run/evidence/issue-16/`。当前候选已补验 #13 的实际只读工具摘要；真实 Terminal 证据取得前不得标记整票完成。历史会话列表、完整队列、可写中止/恢复、长期查询和首版整体验收仍由后续切片完成。

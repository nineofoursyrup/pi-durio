# 当前源码的启动与恢复

本页对应改版源码的 CLI。首版 `f26ae8f` 固定安装的旧命令及验收记录留在原目录，不适用于当前入口。改版的技术验收与日用接受仍按[改版规格](../specs/pi-durio-redesign-spec.md)分别核对。

在源码根目录运行 `npm ci`、`npm run build`。无子命令时打开 TUI，工作区默认当前目录，也可传 `--workspace`。以下示例使用零费用的固定离线响应，输入 `Read README.md` 后按 Enter：

```sh
node dist/src/cli.js --read-only --workspace "$PWD/test/fixtures/project" \
  --data-root "$HOME/Library/Application Support/pi-durio-redesign-demo" --offline-demo
```

无子命令的交互入口默认授予 coding 的 read/write/edit/bash 能力；`--read-only` 收窄为 read。headless `run` / `control` 仍须显式 `--coding`。`tui` 子命令已删除。数据根须放在工作区之外，演示与真实工作使用不同的数据根。

真实任务去掉 `--offline-demo` 后，提交会使用环境中的 `DEEPSEEK_API_KEY` 发起可能计费的请求。`--tool-env-config PATH` 为 coding 声明额外工具环境；模型凭据不默认传给工具。实际启动由使用者按本次任务授权决定。

退出前先等待任务完成，或用 Ctrl+C 请求中止并等待清理；`/exit` 退出，有草稿时确认保存。原缓冲区恢复后显示最多 8 行摘要，逐行按终端宽度截断。摘要保存不了原文的全部身份时，可从 `history --format json` 查询；不再解析退出 JSON 或 `Read back:`。

将下面的显示号和数据根替换为本次记录。摘要中的命令使用 `pi-durio` 可执行入口；从源码运行时以 `node dist/src/cli.js` 替代。使用非默认数据根时，继续和查看命令都追加同一个 `--data-root`。

```sh
node dist/src/cli.js resume s-号 --data-root /absolute/data-root
node dist/src/cli.js show s-号 --trace --data-root /absolute/data-root
node dist/src/cli.js show r-号 --format json --originals --limit 20 --data-root /absolute/data-root
node dist/src/cli.js recover s-号 --inspect --data-root /absolute/data-root
node dist/src/cli.js history --format json --data-root /absolute/data-root
```

`resume` 沿用链尾的工作区与工具授权，不接受 `--coding`、`--read-only` 或 `--workspace`；离线记录接续时加 `--offline-demo`。接续入口只打开界面，不取写入者锁、不调度。链尾完成、原文可取且没有待处理排队项时，下一次 Enter 接续；中断时先进入恢复核对。冻结项不会自动接入。不能接续时只显示原因，新任务须明确提交。

`show` 和 `show --trace` 始终只读，原文查看、分页与复制可用，固定证据、启动分析及其他写操作被拒。非终端环境必须传 `--format json|text`。`recover r-号|s-号 --inspect` 只读查看；不带 `--inspect` 的恢复检查会保存报告，继续或结束旧工作仍需绑定报告身份的决定。

清理未确认时，摘要保留 unknown 并提示恢复核对；不要删除 owner 或原文绕过检查。终端恢复未确认时提示运行 `reset`。正常清理不证明远端请求或所有外部进程都已停止。文件统计只汇总 edit/write 已取得的结果，不计 bash 修改，不从命令输出推断检查通过数。

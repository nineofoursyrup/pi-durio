# pi-durio

macOS arm64 / Node >=22.19.0 的 coding agent。当前实现阶段是 #11：headless 只读小项目任务、持久原文与只读重开。完整首版仍在实现中。

```sh
npm ci
npm run check
node dist/src/cli.js run --workspace "$PWD/test/fixtures/project" \
  --data-root "$HOME/Library/Application Support/pi-durio-demo" \
  --prompt 'Read README.md' --offline-demo
node dist/src/cli.js show --data-root "$HOME/Library/Application Support/pi-durio-demo" --run RUN_UUID
```

`--offline-demo` 使用可控 HTTP/SSE transport，真实执行 Pi DeepSeek 适配器、Harness、SQLite 和 `read`；输出明确标记 offline，没有网络模型推理。默认 `run` 使用 `deepseek/deepseek-flash`、`openai-completions`、`https://api.deepseek.com`，从 `DEEPSEEK_API_KEY` 读取认证。去掉 `--offline-demo` 会发出真实、可能计费的请求。缺凭据/认证拒绝会明确失败，不切换 provider。

只读路径每次创建独立 session/run，最多 8 个可观察 provider 请求，输入最多 32 KiB，单文件最多 256 KiB。仅提供上游 `read`，执行环境拒绝写入和 shell；读取范围为声明项目。这里没有 OS 沙箱保证。`completed` 表示 durable 工作结束，不等于任务验收通过。

数据根必须在项目外。原文与工件保存在数据根的 `objects/`，宿主事实在 `host.sqlite`，每 session 有上游 `durable.sqlite`。没有默认删除或自动恢复。`show --originals` 分页读取取得的原文，`--after` / `--limit` 控制页。文件权限限制当前用户读取，未加密。

SIGINT 请求持久化中止并等待；SIGTERM 请求退出、取消在途请求并等待公开 Harness 关闭。远端终止无法确认时保留 unknown。数据根和 storage 的 owner 冲突会在可写打开前阻断；遗留锁、旧 pending、未确认关闭及跨库缺口不会自动接管。先保留记录、结束已知持有者并核对残留；本阶段没有清除锁/恢复执行命令。

分发检查可运行 `npm pack`。使用 npm 原生 `bundleDependencies` 将精确生产依赖一同打包，供当前 macOS arm64 目标独立安装；运行时仍保留 canonical lock 的完整内容。实际 build、lock、配置和取得的 Git 初态随 run 保存；未取得的未跟踪文件、远端模型权重及服务端未返回内容不声称可复现。

[实现、接口、验证与剩余边界](docs/implementation/pi-durio-v1/issue-11/README.md)。

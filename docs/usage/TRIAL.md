# 当前改版源码的本机试用

先按[启动与恢复](STARTUP-RECOVERY.md)构建当前源码，再在自己的 Terminal 中启动离线演示：

```sh
node dist/src/cli.js --read-only --workspace "$PWD/test/fixtures/project" \
  --data-root "$HOME/Library/Application Support/pi-durio-redesign-demo" --offline-demo
```

1. 输入 `Read README.md` 并按 Enter。离线演示运行真实 Pi 适配器、工具与持久记录，使用固定响应，不调用模型。
2. 完成后用 `/history` 查看记录，Esc 返回。空输入时 `?` 或 `/help` 查看键位。再次提交任务会在允许时接续当前会话。
3. 输入尚未提交的多行草稿，再用 `/exit` 确认退出。摘要应提示已保存的草稿行数；同一工作区与数据根下次启动后用 `/restore` 恢复，恢复本身不提交。
4. 核对退出摘要的任务状态、会话用量和实际清理结果。摘要最多 8 行，宽度不足会截断；原文仍保存。按摘要的会话号使用 `resume s-号` 或 `show s-号 --trace`，并传入相同的数据根；离线接续加 `--offline-demo`。

若选择真实任务，使用自己信任的项目，去掉 `--offline-demo` 并准备环境凭据。交互入口默认 coding，`--read-only` 收窄；提交会产生可能计费的请求。运行中 Ctrl+C 请求中止，随后等待清理。中止、退出和恢复核对都不撤销已经发生的文件修改或费用。

试用时分别记录候选提交、Node/终端环境、实际操作、看到的结果与问题。合成测试不代替真实 Terminal 的中文 IME、格宽、复制及退出观察；这些准备步骤也不自动构成改版技术验收或日用接受。首版固定候选的[原试用说明](../implementation/pi-durio-v1/issue-32/TRIAL.md)保留其当时的入口与证据。

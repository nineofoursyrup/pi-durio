# #17 r2 最短恢复补测

候选 `f67a2edd377d37e3f13bbc0da273028103695d6f`，完整绑定见 [candidate-r2.json](candidate-r2.json)。请在真实 macOS Terminal.app 运行：

```sh
node '/Users/nineofour/pi-durio-v1-run/evidence/issue-17/candidate-r2/recovery-start-terminal-validation.mjs' --manifest '/Users/nineofour/pi-durio-v1-run/evidence/issue-17/candidate-r2/manifest.json'
```

脚本先用真实 offline runtime 准备独立 stopped 源和两项 frozen 请求，明确记为 headless 准备。然后只做：

1. Enter 冷重开；恢复面板应直接出现，无需 Ctrl+L。
2. 按 `e` 明确结束旧工作；等显示 `ended`。
3. 输入 `全新任务`，Enter；等显示已完成。
4. `/queue`，用 → 查看两项旧请求仍冻结，Esc 返回。
5. `/exit` 退出；如有草稿退出确认面板，再按 Enter。最后填 P/F/U，可直接附中文。

每次等待画面稳定后再操作。若出现 `WIDTH_CPR_TIMEOUT`，首次失败必须保留；可 Ctrl+L 后继续其余步骤，最终填 F 并说明。机器单独核对真实新 task、仅新任务请求、旧队列冻结及 raw/stty 恢复，人类 P 不能覆盖机器缺口。

无需重做已通过的 queue-stop、只读限制、IME、复制或缩放。r1 的启动 FAIL、原评分 UNKNOWN 和实际未输入“全新任务”的缺口不被覆盖；修复后的新证据写入 r2 下独立时间戳目录。无付费 provider。

# #17 macOS Terminal 两阶段操作卡

候选 `66c7fcafb34e722eafd738140f9305e5a235db80`，已组合 #17 + 已验收 #18。**原生尚未运行**。在 macOS Terminal.app 手动运行以下命令；运行器将核对候选全部 12725 个安装文件和自身 SHA，使用离线固定传输与临时本地项目。

```sh
node '/Users/nineofour/pi-durio-v1-run/evidence/issue-17/candidate-r1/control-terminal-validation.mjs' --manifest '/Users/nineofour/pi-durio-v1-run/evidence/issue-17/candidate-r1/manifest.json'
```

每阶段开始前会提示按 Enter。每次输入先等画面稳定再提交；若宽度校准提示该次键未应用，确认画面后重新按该次键。输入下面的固定文本即可，无需重复 #16 的输入法、复制、缩放验收。所有自动判定是运行事实；每阶段退出后的 P/F/U 是你的画面观察，两者分别保留。

## 第一阶段：busy 控制、独立后续、撤回、中止

1. 输入 `队列开始`，按 Enter；等待 bash 进行中。输入 `补充当前任务`，按 Enter。
2. 输入 `撤回后续`，按 Ctrl+X，再按 Enter。输入 `保留后续`，按 Ctrl+X，再按 Enter。
3. 输入 `/queue`，按 Enter；按 → 选择第二项 `撤回后续`，按 `w`。确认已撤回，按 Esc 返回。工具此时自动结束。
4. 等任务完成；再用 `/queue` 确认 steer 已接入、撤回项已撤回、`保留后续` 有独立的新 run。按 Esc。
5. 输入 `停止开始`，按 Enter，等待 bash 进行中。输入 `冻结后续`，按 Ctrl+X，再按 Enter；输入 `/compact`，按 Enter。
6. 按 Ctrl+C 中止。在中止中再按一次也不能退出。等已中止；用 `/queue` 和 ←→ 查看 `冻结后续` 与 compact 都已冻结，按 Esc。
7. 空闲时按一次 Ctrl+C，此次不能退出；800 ms 内再按一次 Ctrl+C，退出。
8. 对本阶段输入 `P`（全部符合）、`F 原因` 或 `U 未核实步骤`。如果运行事实缺失，保留该次证据，第二阶段不会开始。

## 第二阶段：重开、恢复限制、明确结束

第一阶段 P 且事实完整后，运行器自动准备重开原 stopped run，提示按 Enter 开始。

1. 恢复面板应显示原状态、最后确认点、未知项、证据和动作影响。
2. 按 Esc 关闭面板；输入 `不得执行`，按 Enter。应保持只读限制，不调用模型或工具。
3. 按一次 Ctrl+C 保存并清空草稿；输入 `/recover`，按 Enter，再按 `e` 明确结束旧工作。结束不会回滚已发生效果。
4. 等提示 `ended`；输入 `全新任务`，按 Enter。应只运行新任务。用 `/queue` 确认旧 `冻结后续` 和 compact 仍冻结。
5. 按 Esc；输入 `/exit`，按 Enter；若出现退出面板，再按 Enter 确认。
6. 输入本阶段 `P`、`F 原因` 或 `U 未核实步骤`。

完成后把屏幕最后的证据目录发回协调 chat。结果位于 `/Users/nineofour/pi-durio-v1-run/evidence/issue-17/candidate-r1/manual/<时间>/`，含按键、ANSI 输出、raw/stty、provider payload、队列/工具/恢复事实和独立人工评分。失败或 UNKNOWN 保留原文件，新尝试生成新目录；不要手动改分数。没有运行真实 DeepSeek 推理，也没有验证新增外部费用。

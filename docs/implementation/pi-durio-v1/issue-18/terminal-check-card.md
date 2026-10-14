# #18 最终集成 Terminal 抽查卡（#31 或 #17 共用候选）

本卡不新增独立的提前人工门槛。#18 新增的是复用现有 overlay 的只读历史内容；原生键码、width gate、退出清理机制未改。合成检查涵盖 40x12 选择保持可见、pending 原文、overlay 吞掉命令样文本、关面板不改执行目标。最终集成时，可与 #17 队列/当前任务的 native 核对合并，使用当时冻结并安装的同一候选。

## 准备

示范数据（已关闭、逐文件 hash 复制，无需新执行）：

`/Users/nineofour/pi-durio-v1-run/evidence/issue-18/demo-r2/data`

workspace：

`/Users/nineofour/pi-durio-v1-run/evidence/issue-18/demo-r2/project`

#18 自身候选安装身份/路径见相邻 `handoff.json`。最终集成核对改用 #31 选定的可验证安装路径，记录该差别，不把本票数据生成版本当成当前产品版本。

## 一次只读操作

在 macOS Terminal 运行冻结安装的 `pi-durio tui --offline-demo --workspace '/Users/nineofour/pi-durio-v1-run/evidence/issue-18/demo-r2/project' --data-root '/Users/nineofour/pi-durio-v1-run/evidence/issue-18/demo-r2/data'`。`--offline-demo` 明确禁止这份操作卡触发付费 provider；本次只用历史操作。

1. 用 F2 的“查询历史（只读）”或 `/history` 打开。应显示 failed 和 usage unknown 的历史任务，而不是执行新任务。
2. Enter 到记录，t 看实际尝试，b 返回，u 看未知费用，b 返回。选 shell.completed 或 tool.output 进入原文；n/p 翻片，d 看脱敏及来源，b 返回。扩大/缩小到 40x12，选择行仍可见，长原文有界且能继续翻片。
3. Esc 关闭历史，当前活动目标和恢复限制保持原样；面板内的 Enter、Ctrl+C/D 或粘贴 `/compact` 不能提交、压缩、退出或解除恢复限制。该条与 #17 忙时原生核对合并时，停止目标须仍是原活动运行。
4. 按已有退出操作离开，沿用 #16 的光标/原缓冲区/raw mode 清理核对。查询前后 `history` 的 snapshot 不应新增 execution/model/tool dispatch；界面没有写入固定动作。

记录实际候选、Terminal/窗口格数、观察、任何首败与截图/人工文字。若发现与真实 Terminal 独有的可复现问题，保留失败再修；本卡本身及合成通过不代表 native PASS。无需重复已覆盖、条件未变的全部 #16 原生矩阵。

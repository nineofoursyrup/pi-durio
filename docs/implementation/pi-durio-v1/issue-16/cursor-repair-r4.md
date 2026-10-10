# #16 r4 光标修复

状态：已修复可重放的 ANSI 光标冲突，真实 macOS Terminal 复测 **NOT RUN**。#16 保持 FAIL / 待人工验证，不能解锁 #17/#18。r1/r2/r3 原候选、manifest、人工记录和首败没有改写。

## 故障与因果证据

用户报告“光标消失、闪烁或出现多个光标”。r3 两份真实 Terminal normal 日志的第一帧都在编辑位置输出一个反色软件光标，同时开启硬件光标；后续重绘在硬件光标显示状态下移动光标绘制不同屏幕行。这个输出模式可通过真实 Pi Editor、TuiAltScreen 与 Terminal.write 接缝独立复现。

- `/Users/nineofour/pi-durio-v1-run/evidence/issue-16/cursor-repair/recorded-ansi-audit.json` 记录原 ANSI/input 的 SHA-256、首帧信号与重绘统计。
- `first-failure.log`：第二份真实日志 events 40–48 的输入前缀 `读取 README` 在实际 Pi ANSI 边界出现双重光标绘制。
- `first-paint-failure.log`：可见光标期间输入 A，绘制帧没有先隐藏硬件光标。
- `focused-after.log`：相同两条回归修复后通过。
- `tui-expanded.log`：12 项 TUI 检查通过。长多行在 40×12、80×24、120×30 的光标可见，未证实裁剪故障，因此未改变布局。

这里确认的是实际程序写出的光标指令与绘制冲突。Terminal.app 的最终视觉效果、IME 候选窗位置与自然光标闪烁仍需真人观察；合成终端不是验收替代。

## 最小修复

`HardwareCursorEditor` 复用公开 Editor，仅移除公开 `CURSOR_MARKER` 紧邻的软件光标反色起始码；保留字符、终端格宽和硬件插入标记。失去焦点时不输出插入标记，也不遗留软件光标。独立的反色组件样式和 renderer 的选文样式不受影响。

公开 Terminal.write 接缝在每个同步绘制帧开头隐藏硬件光标。Pi 仍负责最终位置、显示状态和退出后的恢复；绘制不依赖终端支持同步输出才能避免光标跟随绘图位置。退出后恢复原 write 方法。未改 Pi 包、版本、依赖锁或执行生命周期。

依据：精确安装的 `@earendil-works/pi-tui@1.1.0` 发布包公开类型、README 及实现；另核对 [upstream README](https://github.com/earendil-works/pi/blob/main/packages/tui/README.md) 的 Focusable / CURSOR_MARKER 接缝。发布工件与 main 不视为相同身份。

## é 观察边界

用户进一步明确“没能输入或粘贴出 é”。第一次 normal 输入记录无 U+0301/é，第二次仅误粘贴的大段 fixture 中包含组合字符。因此原人工 FAIL 保留，具体结论是测试字符未成功进入、尚未完成对应验证；没有证据认定编辑器拆字缺陷，也没有改写组合字符逻辑。

实际 bracketed-paste 路径的回归输入为 `A👩‍💻é中B`，验证不提交、硬件光标格宽和 Ctrl+D 整簇删除。该机器检查不能覆盖真人是否成功粘贴及最终字形。

## 最小真人复测

新 r4 runner 提供 `--scenario cursor`。直接粘贴 `A👩‍💻é中B`；Ctrl+A、右两次、Ctrl+D 应得到 `A👩‍💻中B`。随后检查多行、缩放、菜单/焦点切换、Ctrl+L、IME 候选位置、输出时输入，以及退出恢复。每项明确 PASS/FAIL/UNKNOWN，失败注明步骤。

runner 新记录 terminal-write 的时间和字节偏移，便于与真实输入精确关联。未开始 r4 真人测试，也未要求用户中断当前测试。其他未完成的真实 Terminal 项目继续保留 UNKNOWN。

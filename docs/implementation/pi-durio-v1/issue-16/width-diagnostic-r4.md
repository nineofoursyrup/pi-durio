# #16 r4 宽字符失败诊断

状态：真实 macOS Terminal **FAIL**。r4 人工复测报告“emoji 后有莫名空格，光标在 B 前面”；尚无足够证据确定 Terminal 实际占格，因此没有先按假定宽度修改产品。#16 不满足依赖，#17/#18 继续阻塞。

## 已证实

- 候选 `42ff424757f83c8578949d2a31f31eafca8ad486`，本次工作树基线 `9bf2ffa03263a17a2ed5bec0078477f9002bafb3`；原 r3/r4 工件不改写。
- 两份真实 Terminal 记录均收到完整 bracketed paste。输入包含 U+200D 和 U+0301，后续绘制中 `A👩‍💻é中B` 字节原样保留，没有在 emoji 后写入空格。
- 真实绘制帧将完整串的硬件光标设为第 8 列；这只证明产品写出的指令，不能证明 Terminal 中的实际字形占格或插入点。
- 原有合成测试中的第 8 列断言因此不足以判定该真人失败通过。原始 FAIL 和 operator-observation 保留。

证据索引：`/Users/nineofour/pi-durio-v1-run/evidence/issue-16/width-repair/recorded-r4-audit.json` 记录输入、绘制帧、byte offset、来源及 SHA-256。原始记录位于 `manual/2026-10-09T11-19-18-936Z/cursor` 和 `manual/2026-10-09T11-20-14-120Z/cursor`。

## 最小真人诊断

```sh
bash '/Users/nineofour/pi-durio-v1-run/evidence/issue-16/width-repair/run-width-diagnostic.sh'
```

这条命令由用户在本人 macOS Terminal 中手动运行。它先校验固定 r4 工件，再显示短测试串并请求终端 CPR；Terminal 回报的列号是独立测量，Pi `visibleWidth` 只是被比较的数值。它还读取原 r4 帧，比较完整串自然输出的末列与原实际定位指令。没有模型调用或外部 UI 自动化；不改 Terminal 设置、不操作剪贴板，退出恢复 raw mode 与原屏幕。唯一视觉反馈是自然输出是否也出现 emoji 后空白。

CPR 协议依据：[XTerm Control Sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)。终端未回报、响应换行或取消均记 UNKNOWN，不将缺证据归为 PASS。若两种列号相同，只说明这个诊断未复现列宽差异，不证明字形、IME 或整个 #16 通过。

`scripts/terminal-width-diagnostic.mjs --self-test` 检查响应解析与比较器，明确属于合成协议检查。语法检查、固定 r4 的 12687 文件校验和非 TTY 拒绝均通过；实际 CPR **NOT RUN**。取得报告前不确定根因，也不把 ANSI 自身使用的宽度计算重复当 oracle。

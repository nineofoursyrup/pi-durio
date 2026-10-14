# pi-tui 1.1.0 隔离能力探查记录

2026-10-09，在 `/tmp/pi-tui-1.1.0-feasibility-ljj311ws` 解包官方 npm 发布制品，读取其公开 API，并运行一次无模型的合成 Terminal 接口 smoke。这里保留结果与源码副本，不是产品测试套件，也不是可双击的 TUI 原型。

- 发布包：`@earendil-works/pi-tui@1.1.0`。
- tgz SHA256：`5d0f9dfb31c06f27d1fb2b05d166fc0d33430f53ece0a3ff3f69d55950f1430b`；下载制品 SHA512 与 registry `dist.integrity` 一致。
- registry provenance 声明源码为 `abe508e1b89912adde45528136c3221eb69acdd7`。仅读取声明，未做 provenance 密码学验签。
- 运行环境：Node `v26.8.2` / darwin arm64。未运行包脚本、真实模型、macOS Terminal.app、系统剪贴板或产品 runtime。
- [probe-result.json](probe-result.json)：本次 18 个合成观察均通过。字段名是探查对象，不表示已经取得 macOS Terminal 的对应验收证据。
- [probe.mjs.txt](probe.mjs.txt)：原探查源码的只读副本；它依赖 scratch 中解包的 `package/dist/index.js` 及隔离依赖。本目录未携带依赖，不可将源码副本直接当独立可运行产物。
- [source-comparison.json](source-comparison.json)：固定发布来源与研究快照 `6fb2e7815167e6b19006fc526d1a5d0f5f998787` 的所查文件是否相同（true 为相同）。
- [registry.json](registry.json)、[provenance-payload.json](provenance-payload.json)：本次读取的元数据。

合成探查覆盖固定 footer、滚动/跟随、点击/拖选与注入的复制回调、Ctrl+J/Enter/Ctrl+D/Ctrl+C/Esc、bracketed paste、宽字符、resize，以及退出缓冲区与历史输出行为。它没有验证真实按键编码、IME 候选窗、字体、外部剪贴板、ProcessTerminal 的 raw mode/信号清理、长历史内存上限或性能。

## 影响设计的发现

1. 公开 `TuiAltScreen`、`VStack`、`ScrollView` 足以作为固定输入与状态的基础。`ScrollView` 不自动提供历史分页或虚拟化；有界保留和输出读取仍是宿主责任。
2. 默认 Ctrl+J 换行、Enter 提交；Ctrl+D 默认向前删除，Ctrl+C 与普通 Esc 不自动承担产品中止/退出语义。宿主需按最终键盘合同接线。[keybindings](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/tui/src/keybindings.ts#L120)、[Editor](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/tui/src/components/editor.ts#L745)。
3. 默认 `stop()` 打印完整 document；公开 `stop({preserveScreen:true})` 的合成观察为退回主屏且不打印历史。拟采用这一公开入口并由宿主输出有界的退出摘要，固定版本后保留行为验证。[TuiAltScreen.stop](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/tui/src/tui-alt-screen.ts#L406)。
4. macOS Terminal 复制可注入 `copySelection` 并使用 `pbcopy`；不能把纯 OSC 52 无报错当成复制成功。本次仅注入模拟回调，未使用系统剪贴板。[复制适配注释](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/tui/src/tui-alt-screen.ts#L1468)。
5. 发布来源与后续研究快照的光标/Editor 实现不同：后者增加 `renderFakeCursor`、硬件光标去重和 APC 边界修复。保持 #3 的候选依赖基线，真实 Terminal 的中文输入候选窗与光标行为列为待验；不提前维护 fork，也不将后续快照的行为归给 npm 1.1.0。

# #16 r5 字宽修复（真人验收仍待完成）

用户于 `2026-10-09T12:01:44.363602Z` 明确允许限定的 A5 例外：两份上游源文件的小型共享宽度入口补丁，加上宿主当前 Terminal 的自动校准与失败保留。原规格、r3/r4 及其首次失败不变；[授权原文](width-exception-authorization.json) 与 [诊断](terminal-width-diagnosis.md) 分别保留。没有付费调用、main 合并、release 或关闭票的新增授权。

## 实现与身份

- 依赖实际版本为 `@earendil-works/pi-tui@1.1.0-durio-width.1`。`vendor/pi-tui/` 保留官方原 tgz、integrity、精确源代码 patch、可重建脚本绑定、派生 tgz 与 manifest。两次重建的 tgz SHA-256 一致：`90a1f855d1e5f30d9b97c8733ca0a1c3a05ce07d5e95af4e2fed6f553e34f62a`。没有安装后改写官方模块的 hook。
- 继续使用 Pi 的 Editor、TuiAltScreen、布局、选择和复制；共享宽度入口统一所有字符格计算。每次更新在帧间执行，重置选文、invalidate 并强制完整重绘。
- `width-probe.ts` 在实际会话中串行测量完整非 ASCII 字符簇的自然输出和 `A…B` 上下文。每个 CPR 后等 DA1 结束标记；超时保留未结束交换的标记，迟到 CPR 不会错配到下一字符。ProcessTerminal 自身启动协商先消费它发出的 DA1。括号粘贴中的转义文本不作为回答。
- 探针通过 DECSC/DECRC 在同一次输出内恢复上一幅已确认画面的 caret 位置，并恢复原可见状态；查询期间不把 caret 长时间停在测量行。这个机制不能代替原生 IME 观察。控制序列依据 [XTerm 文档](https://invisible-island.net/xterm/ctlseqs/ctlseqs.pdf)，Apple Terminal 的实际表现仍由真人候选复验确定。
- `width-gate.ts` 检查完整逻辑草稿、待显示源文本和实际输出帧。新宽度未确定时暂停新画面与几何输入；runtime 继续持久保存事实，刷新只合并 UI 投影。每次会话重新测量，Ctrl+L 显式重测，不按 TERM/版本假定字体未变，也不把某个 emoji 的宽度推广给其他字符。
- 等待输入绑定到达时的 phase/run/focus/modal。只有普通文本或完整括号粘贴在上下文仍有效时恢复。Enter、导航、鼠标、确认等动作要求针对新画面重新操作；失效输入写入 `ui-drafts/pending-input/`，状态 `not_applied`、`automaticReplay:false`，包含原始事件与到达上下文。此收据没有受理/执行权限。草稿恢复不会读取或重放它。
- Ctrl+C/D、Esc、焦点及信号沿用既有菜单优先级、800ms 确认与 #14 生命周期。中止/退出保留等待输入，取消探针并有界等待查询结束，再 drain、退出 alternate screen、关闭 synchronized output、恢复可见光标。未等到响应边界明确报告 UNKNOWN，不假设无限迟到响应已经消失。
- 内存待处理输入上限 64 KiB；超限事件落盘且保持未应用。单簇探针上限 256 UTF-8 字节，会话 profile 上限 4096 簇；超出、窗口无法测量、超时和上下文宽度不一致均保留未验证状态，不回落旧模型冒充校准成功。依赖 API 为进程级配置，因此拒绝同进程并发 renderer。

## 验证

外部证据目录：`/Users/nineofour/pi-durio-v1-run/evidence/issue-16/width-repair/r5/`。

| 检查 | 结果与边界 |
| --- | --- |
| `npm run check` | 65/65 PASS，`full-check-first.log`；包含全部既有 runtime/TUI/recovery 检查与新字宽行为 |
| 最终影响检查 | 8/8 PASS，`final-affected-checks.log`；覆盖追加的 SIGTERM/同步输出关闭和修改后的候选入口校验 |
| 实际 ProcessTerminal + 合成 PTY | PASS，`process-terminal-probe.{py,json}`；真实启动协商、分片/合批的 CPR+DA1、普通输入透传；**不是原生 Terminal 验收** |
| 字宽入口静态证明 | 复用同一 patch 的 7 项已通过证明：独立 CPR oracle 下的 caret、换行、选文/复制、字符簇编辑及 API 缓存/校验；原库 5 项 FAIL 原件保留 |
| 等待/失败路径 | 分片/迟到回答、粘贴中的 CPR、上下文不一致、首次按键、首次完整粘贴、分开输入组合标记、等待 Ctrl+C/菜单 Esc、SIGTERM、收据保存、运行完成期间旧 Enter 不变成新任务均覆盖 |
| 同步输出清理 | 等待期间 Ctrl+C 退出及 SIGTERM 的真实 TUI 输出末次 `2026l` 晚于末次 `2026h`；alternate-screen 退出与可见 caret 恢复路径保留 |
| 真人 r5、IME、视觉 glyph、真实鼠标复制 | NOT RUN，不能据此解锁 #17/#18 |

首跑记录保留：`transport-first-failure.log` 是新增模块尚未实现的编译失败；`product-first-run.log` 的失败是测试原先错误假设 StdinBuffer 会把普通字符串作为一个事件，实际按字符拆分，收据原文未丢；`context-barrier-first-run.log` 暴露检查辅助函数把 ASCII 错误提示误当稳定产品帧，且未在超时后显式重试。改为检测完整产品 caret 帧和明确完成状态后，相关检查通过。没有删除或替换第一份记录。

候选源码固定为 `e4571452a1ebf712cd60282ded0161640670d70e`；[完整候选指针](candidate-r5.json)。独立安装包 smoke 和源码字节绑定通过。安装 smoke 第一次脚本错误地只解析 CLI JSON 的第一行；产品运行本身已 completed/cleanup confirmed。保留原运行 stdout 和 `candidate-r5/smoke-first-failure.{mjs,json}` 后，修正解析并复用原运行完成 headless 读回，没有覆盖原执行或再次制造模型调用。

## 人工入口

固定 r5 manifest 由候选脚本生成，单一 runner 先运行 `cursor` 的三项短复测（原样 caret、首见新 Unicode、缩小再恢复）。FAIL/UNKNOWN 或机器恢复失败立即停止，其他场景保持 NOT RUN。短复测通过后再集中运行 normal/stop/esc/exit/fault。观察按明确编号填写 P/F/U，raw/stty、按键、clipboard 读回和同 run headless 结果自动记录。

normal 必须观察**持续新增非 ASCII 输出时正在选择中文 IME 候选**：候选窗和 caret 是否仍在输入处；不能以离线 FIFO 结果代答。Terminal 原生 emoji 字形间隙不属于这项补丁所承诺消除的现象；caret/换行/选择坐标正确性仍必须通过。

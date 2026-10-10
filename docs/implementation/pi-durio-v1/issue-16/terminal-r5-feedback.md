# r5 真实 Terminal 部分观察

固定候选：`e4571452a1ebf712cd60282ded0161640670d70e`；本地 integration merge：`7a067340dda2e4fb84a4472ff91cfec1100c626f`。65/65 组合检查、8/8 最终影响检查、独立安装和 12,704 文件核验通过；合成 PTY 不代表本节真人观察。

用户明确反馈“PPP，但emoji还是会占多个字符”。对应本次 runner 的 [C1–C3 原始记录](terminal-r5-cursor-observation.json) 均为 PASS：原样光标、首见 Unicode、约 40×12 缩放恢复。机器记录表明 raw/stty 均恢复，当前会话实测 `👩‍💻` 占 5 格，校准没有报告错误。[直接反馈及原记录哈希](terminal-r5-short-feedback.json) 保留了关联证据。

这只确认三项短测。Terminal 的原生 emoji 占格和字形间隙继续存在；限定补丁匹配实际坐标，不承诺改变原生字形。

之后用户完成了 normal 的 N1–N4 观察，四项均填 P：[原记录绑定及机器结果](terminal-r5-normal-partial.json)。IME、多行、字符簇、复制、滚动焦点和窗口恢复的人工作证保留；机器确认 raw/stty 恢复及同一 run headless 结果一致。此次任务最终由 stop 中止、usage 为 partial，最小窗口填 U；不把这些改写为成功完成或已测最小尺寸。复制的人工 PASS 与未触发适配器自动读回记录分开呈现。

用户随后关闭了 Terminal。剩余 stop、esc、exit、fault 尚未开始。按用户要求再次检查 Computer Use，工具仍明确拒绝访问 `com.apple.Terminal`：[拒绝原文](terminal-r5-computer-use.json)。没有通过其他控制工具绕过。

已准备一个[未完成项续测入口](terminal-r5-unfinished-entry.json)，先运行四项原候选场景，再用同一冻结安装的短 README 补验成功完成和明确最小可用尺寸。新脚本语法、绑定身份及非 TTY 拒绝已检查；这些不算真人验收，原 runner/manifest/安装均未改变。

#16 尚未 integrated-accepted，#17/#18 仍不解锁。未测项保留 UNKNOWN/NOT RUN，r3/r4 FAIL、各次人工现场、首败和原规格均保留。付费调用、#32 日用接受、main 产品合并及发布未执行。

## 后续 STOP、ESC 与 EXIT 读回

用户后续独立完成 STOP 与 ESC，原评分均为 P，机器确认 raw/stty 恢复、清理 confirmed 和同 run headless 一致：[STOP](terminal-r5-stop-readback.json)、[ESC](terminal-r5-esc-readback.json)。这补充了上文当时尚未开始的两项；此前记录保持原样。

2026-10-09T13:17Z 的 EXIT 评分为 F；用户反馈“执行6的时候第一次没有退出全屏，第二次才退出成功”。原始日志首次快速双按为 Ctrl+C（177ms），后续快速双按为 Ctrl+D（309ms）；运行中的 Ctrl+C 请求 stop 后留在界面，最终 cleanup confirmed。因此本次原始记录本身不能证明 Ctrl+D 首对失效，原 F 也不改写为 P。[反馈、实际键码和文件哈希](terminal-r5-exit-failure.json) 分开保留了这些事实。

随后独立回归确实复现一个产品缺陷：首次退出提示产生的 CPR/DA1 校准回包被当成用户操作，清掉确认。r6 在用户输入失效逻辑之前消费协议回包，保留真实其他输入及上下文失效和 800ms 规则。两个回归首败及 23 项受影响检查、独立安装结果见 [r6 修复与适用性](confirmation-repair-r6.md)。r6 使用新的首次 Ctrl+D / 空闲 Ctrl+C 原子评分，不以新评分覆盖旧 EXIT。

旧 EXIT 日志中没有 CSI I/O；操作卡额外提出的 OS 窗口切换探查继续 UNKNOWN，不推断用户是否切过窗口，也不引入新的平台焦点探测功能。T6 的输入组件、弹层和运行场景边界按其原合同核验。fault、正常 completed 和明确最小窗口仍需原生补验。

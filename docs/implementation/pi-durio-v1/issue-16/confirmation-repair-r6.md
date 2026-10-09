# #16 r6：首次退出确认与校准回包

首次 Ctrl+D 或空闲 Ctrl+C 显示中文确认提示时，新字符会触发 CPR/DA1 字宽查询。r5 的外层输入观察器先把这些协议回复当作“其他按键”，清除了刚设置的确认；下一次同键便重新开始确认。r6 在外层观察器处理用户动作之前，调用现有探针的回复分类与消费入口。修改只涉及 `app.ts`、`width-gate.ts`；Pi 补丁、字宽算法、测量流程、依赖、runtime 及 800ms 窗口均未改变。

这项代码缺陷由两个独立 RED 回归确认，不能直接从旧人验失败推断：`candidate-r5/manual/2026-10-09T13-17-02-966Z/exit/` 的第一组快速输入实际为 `0x03`（Ctrl+C，177ms），运行结果为 intent `stop`；随后 `0x04`（Ctrl+D，309ms）才退出。用户的 EXIT `FAIL` 原件不变。首次 Ctrl+D 后确有 36 条 CPR/DA1 输入。完整旧记录绑定于 `width-repair/r5/native-exit-failure-readback.json`，SHA-256 `b1c5c9af5dad254809d081d4f8889b49689fd466de52e230fc3e5cbedd8097ff`。

验证证据位于 `/Users/nineofour/pi-durio-v1-run/evidence/issue-16/width-repair/r6-confirmation/`：

- `first-red.log`：修改前，首次 Ctrl+D 与空闲 Ctrl+C 两项独立失败；`first-green.log`：最小修复后 2/2 PASS。
- `affected-checks.log`：`npm run build` 后执行 TUI 与宽度测试，23/23 PASS。覆盖首对确认、迟到/分片协议回复、800ms 过期、实际文本/焦点/PageUp/modified F3/括号粘贴/resize 在等待测量时仍立即取消确认，以及中止、modal 优先级、SIGTERM、草稿/收据、运行完成后的旧 Enter 禁止重放。
- `runner-checks.log`：候选清单增删/字节变化拒绝检查 1/1 PASS；新 runner 语法与差异检查通过。
- 没有为收尾重跑未受影响的全量 runtime 检查。r5 的确定性结果按未变化的代码/输入/依赖继续适用；本轮结果不等同真人 Terminal 验收。

## r6 人工项目与历史结果适用性

新 runner 每次要求一个 `--scenario`，没有自动串行多个场景。r5 runner、manifest、安装及原始证据保持冻结。r6 的冷首次按键场景单独启动新 TUI，不能先做超时/取消测试来预热提示。

| 项目 | 当前证据与 r6 要求 |
| --- | --- |
| C1–C3 | r5 用户 PASS；caret、宽度/换行与 resize 路径没有改变，沿用原生观察及本次相关回归，不写成 r6 新测 PASS |
| N1–N4 | r5 用户 PASS；持续 Unicode 输出时 IME、编辑、多行、复制、菜单和视觉恢复实现不变，沿用原生观察。原 normal 为 aborted，不能据此宣称正常 completed；minimumGrid 仍 UNKNOWN |
| STOP / ESC | r5 用户 PASS；真实控制键、焦点、菜单和 runtime 中止路径未改，23 项检查覆盖这些边界；沿用记录。STOP 中后续退出不代表冷首次确认已通过 |
| EXIT_FIRST_PAIR | r6 必须新测：输入 `read README` 并提交，运行中空输入，首次 Ctrl+D 双按间隔不超过 800ms；第一对就应请求退出、等待清理并恢复终端。机器应记录 `0x04`、intent `exit`、cleanup `confirmed` 与同 run headless，一次 stop 后的退出不能满足本项 |
| IDLE_C_FIRST_PAIR | r6 必须新测：空闲输入 `keep this draft` 不提交；首次 Ctrl+C 保存并清空草稿，800ms 内第二次退出恢复。机器应记录 `0x03`、零 provider 请求和 draftSaved；后续成功不能替换首次失败 |
| 800ms 超时 / 真实输入、焦点、resize 取消 | 本次离线检查 PASS；保留此前人验材料及其原评级，旧 EXIT 总项 FAIL/UNKNOWN 不提升。两项原子首次确认的 P 不等同重测这些子项 |
| 可捕获 fault | 旧反馈 UNKNOWN；仍需独立真人场景 |
| 正常 completed / 精确最低字符格 | 原 normal 和补充记录尚未满足；仍需补验，不能用本次首次退出项目代替 |

首次失败应安全退出后填 F，记录第一对。原始输入/resize/ANSI、机器结果和评分均写入新的时间戳目录。人工期间不运行 Terminal 自动化，不设置假的 TERM；付费 provider 继续 NOT RUN。

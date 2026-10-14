# #16 原生宽度故障与 A5 决策前提案

当前状态：**真人 FAIL / 产品接入 BLOCKED，等待明确依赖补丁例外或替代决策**。没有 r5 产品候选；不解锁 #17/#18。诊断提交为 `5a46dcda811c0ce9964ecaecce9da2dc8e606ea2`，基线为 `9bf2ffa03263a17a2ed5bec0078477f9002bafb3`；最新集成的 #15 改动尚未同步到本诊断分支，无生产代码变更。

## 已证实

2026-10-09 的用户手动 CPR 诊断在 Apple_Terminal 488.7 / macOS 27.2 / Node v26.8.2 下测得：`👩‍💻` 占 5 格，Pi 1.1.0 算为 2 格；`A👩‍💻é中B` 实际宽 10 格、末列 11，r4 将光标定位到列 8。自然输出也有 emoji 后空白，用户答 `yes`。raw/stty 恢复均通过。已测数据不能外推成所有 Terminal 或所有 emoji 的固定规则。

Pi 的私有 `graphemeWidth` 被 Editor 换行/导航、renderer 光标与鼠标选文共用，没有统一的公开配置入口。官方 registry 当前 latest 仍为 1.1.0，上游 main `f1b2e77f5b13b2a199b1052cb79c235451afe7d7` 也没有该入口。仅改 CUP 不会修复换行和选文；插空格又会改变实际占格和复制内容。

以真实 CPR 为独立 oracle 的离线回放保留 5 个首败：宽度 7 vs 10、caret 8 vs 11、9 格窗口错误地放入一行、切片只取 B、实际 AltScreen mouse 选文只复制 B。整簇删除原本通过。

## 可审阅的最小提案

外部目录：`/Users/nineofour/pi-durio-v1-run/evidence/issue-16/width-repair/proposal/`。

- `README.md`：具体阻塞调用点、方案比较、维护面、审批与验收边界。
- `upstream-width-overrides.patch`：针对精确 1.1.0 源图源码的 2 文件公开接口草案；不是现有官方 API，不接入产品。
- `dynamic-plan.md`：首见字符/stream 暂存、原生 CPR 时序、缓存失效、未知/超时与退出收据的具体接入合同。
- `replay.mjs`、`original-first-failure.{json,log}`、`proposed-result.{json,log}`：原库首败及外部接缝 7 项可行性检查通过。
- `dynamic-gate.mjs`、`dynamic-replay.mjs`、`dynamic-after.log`：现有 public `invalidate()` + `renderNow(true)` 足以刷新旧控件的动态证明，6 项通过；首键 prototype 失败另存 `dynamic-startup-first-failure.log`。
- `upstream-readback.json`、`build-manifest.json`、`packet-manifest.json`：版本、来源和工件身份。

建议用户明确允许**小型字宽公开接缝 + 宿主原生动态校准及失败保留**这一窄范围例外，继续复用 Pi Editor/布局/选文；承认并固定本地依赖补丁的独立身份，正式上游接口满足后撤销它。另可保持 BLOCKED 等待上游，或以更大范围重开 TUI 核心依赖选择。

动态提案不会只缓存一个 fixture：首个输入先由原 Editor 保存完整文本，后续输入与画面暂缓；新复合字符按整簇测量，成功后更新共同宽度表，公开失效/重绘，再按 FIFO 接入输入。stream 只合并 UI 投影，runtime 原文不改。超时不回落错误宽度，不执行 queued Enter；正常退出保留草稿和未应用输入收据，晚到测量不能改状态。

## 尚未通过

7 项静态和 6 项动态通过均是 **外部隔离提案的离线可行性**，不是 r5 产品或原生 Terminal PASS。真实 ProcessTerminal 的 CPR+界标时序、所有首次出现字符的测量、输入收据落盘、延时/内存、产品打包及新真人观察仍待授权后的实现和验证。Terminal 自然字形空白是否满足用户要求也保留未解决状态。

原型直接调用 close，只证明清理与晚回包；它把 Ctrl+C 也暂存，不能原样产品接入。正式实现仍须保留 app.ts 菜单/焦点优先级，使停止、退出与系统信号在校准等待/错误时仍可操作，严格沿用 #14 的生命周期保证。

依据 [规格 A5](../../../specs/pi-durio-v1-spec.md) 与 [#3 已确认边界](../../../design/upstream-execution-recovery.md)，只能依赖补丁/fork 或换核心依赖才能满足时应重新提出实质取舍。未直接修改 node_modules、package/lock、runtime/CLI；r3/r4 工件和真人首败不改，r4 的 12687 文件完整性再次核对通过。没有付费模型调用、push、PR/tracker 变更或关票。

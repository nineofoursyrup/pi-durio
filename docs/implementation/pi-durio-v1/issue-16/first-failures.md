# 首次结果与修复链

- `query-first-red.log`：新增有界查询行为测试先失败，原因是 `src/query.ts` 尚不存在；实现查询后通过。不是产品运行成功证据。
- `tui-first-red.log`：新增键位/runtime UI 行为测试先失败，原因是 `src/tui/app.ts` 尚不存在；最小 UI 实现后通过。
- `initial-ui-tests.log`：首次 query + 两个 UI 测试共 3/3 通过。随后新增 viewport/focus 确认失效、受控在途停止/退出和退出草稿覆盖。
- `check-before-candidate.log`：18/18 检查通过；后续 Unicode 原文翻页与终端异常清理补强后产生独立 `check-candidate-r1.log`，不覆盖初次结果。
- 真实 Terminal 自动入口首次失败：`cua.getApp("Terminal")` 被安全策略拒绝。保留完整拒绝文本；无替代工具绕过，IME/复制/键位/缩放/退出恢复仍 BLOCKED。人工 runner 没有填写用户观察。

- `candidate-r1` 是 ee6d8bd 的首次独立安装 smoke，仅保留历史，不交给使用者作为正式验收候选。协调者发现原主会话暴露底层事件和重复回答；后续收口为自然对话/工具状态投影，原始字段留在详情。`tui-conversation-first.log` 与 `tui-conversation-r2.log` 保留修订后 6/6 通过，补了不泄露事件标签/重复同一回复的断言。

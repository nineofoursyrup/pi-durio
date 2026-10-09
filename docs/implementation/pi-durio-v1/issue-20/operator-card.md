# 给 #31 的最终组合抽查卡

此卡不要求现在重跑原生矩阵。本票没有新增原生键码门槛；`/storage` 复用已验收的普通 panel、滚动与模式清理，合成检查不代替最终组合 Terminal 核对。CUA 的既有拒绝继续有效，不用 AppleScript/cmux 等绕过。

最终 #31 候选准备好后，先把本票只读 archive 还原到**全新测试目录**，再用最终候选打开该副本。不要直接把任何原验收目录当可清理数据根。

```sh
storage_fixture=$(mktemp -d /tmp/durio-storage-native.XXXXXX)
# CLI 替换为 #31 冻结候选；ARCHIVE 取本票 handoff 中的只读 fixture archive。
node "$CLI" storage restore --archive "$ARCHIVE" --destination "$storage_fixture/data"
mkdir "$storage_fixture/project"
node "$CLI" tui --workspace "$storage_fixture/project" --data-root "$storage_fixture/data" --offline-demo
```

1. 输入 `/storage`：占用与 session 可见；主任务输入和目标不改变。40×12 与普通窗口能用方向键选择、PgUp/PgDn 查看。
2. 选择该**测试副本**的 session，按 `c`：显示字节、范围、保留/失效说明和预览 ID；此时文件仍在。Esc 关闭不会删除。
3. 再开预览，Enter 明确提交：按每部分显示完成；再开只读 history，原任务结果与已保留 host 原文仍在，durable session 状态说明已清理。关闭面板后正常退出，保留已有 Terminal 清理责任。

只记录实际观察。若发现具体窗口/键码问题保留失败，并只重测受影响行为。这里不触发模型，不调用付费 provider。

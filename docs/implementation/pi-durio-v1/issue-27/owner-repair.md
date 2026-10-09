# STD-03：metrics 原始事实写入遵守 data-root owner

独立 Standards review 在候选 `1be8e2826fa5d523e9224677838dd97b2d4d8ac3`
发现 `recordAcceptance`、`recordFeedback`、`recordCostEstimate` 直接可写
打开 Evidence。短 SQLite 事务仅保护事务内的原子性，不能替代运行、
归档或维护持有的 data-root owner 生命周期。第二进程可在持锁期间写入，
违反 spec R2 与运行记录保留设计第 144 行。本修复不声称曾发生实际数据损坏。

三个同步公共 API 和 CLI 参数保持不变。`withOwnerSync` 在读取/验证输入
所引用的事实和首次可写打开前解析真实路径；没有本地 lease 时使用已有
`proper-lockfile@4.1.2` 的公开 `lockSync`，并沿用同一 `.lock` 与
`owner.json` 协议。无自动陈旧锁接管。输入错误、重复 ID 和正常写入完成
后均关闭 Evidence，再同步释放短期 owner。

异步 `acquireOwner` 仍返回 Promise，只有本模块实际取得的 lease 才登记
到私有 registry。同进程同步回调复用 lease 前检查其生命周期、真实目录和
锁的设备/inode、实际 owner claim；不接受调用者构造的 lease，也不凭 PID
或复制的 `owner.json` 授权。canonical 路径一致的别名复用同一 lease，另一
数据根无法复用。丢失或开始释放的 lease 立即停止借用；释放失败向调用者
暴露错误并保留未确认状态，不能因此删除其他 owner 的 marker。

`task.accepted` observation 内的同步要求记录保留。公开 offline runtime
回归在实际模型 transport 入口确认必要要求已保存；原先基于实际 shell
结果的 PASS/FAIL、来源缺失后的 unknown 和修订投影继续验证。

回归通过公开 API/CLI 在独立子进程提交三类有效输入，覆盖原路径与 symlink；
持锁拒绝后比较完整数据根文件内容 inventory。另覆盖空闲写入、重复 ID、
并发相同 receipt 的去重/拒绝后重试、错误 root、丢失 claim、替换 lock、
释放中状态、清理失败、陈旧锁，以及持锁期间的只读报告。完整 test 文件为
`test/metrics-ownership.test.ts`；既有 metrics/runtime/storage/recovery
检查保留。首败和各轮 build/test 日志保存在本次执行的外部 evidence 目录，
最终组合候选的全项目检查由集成主任务运行。这里的验证未使用付费 provider、
VM 执行或原生 Terminal，不代替 #30/#31/#32 的门槛。

# #14 首败与修复记录

原日志均保留在 `/Users/nineofour/pi-durio-v1-run/evidence/issue-14/`，未覆写或删除第一次失败。

| 首败 | 所见事实 | 修复及后续证据 |
| --- | --- | --- |
| `red-01-test.log` | 首次 stop 后 getter 变为 exit，结果被错误改写为 unknown | 同步冻结首次意图；`green-01-test.log` PASS，后来扩展到首个 await 前及真实 CLI 初始化竞态 |
| `red-02-build.log` | 尚无 cleanupTimeoutMs/waitForRun 公开接口 | 最小可选接口与公开 Chord 等待；后续 lifecycle 检查 PASS |
| `green-02-test.log`、`green-03-test.log`、`green-04-test.log` | 用可立即取消的空/部分 SSE 流期待 cleanup timeout，实际已正常返回 confirmed | 这是测试 fixture 的错误假设，未据此放宽产品状态；改为真实不响应取消的 transport promise，`green-05-test.log` 验证 timeout、迟到 HTTP 记录及保留 owner |
| `red-03-test.log` | proper-lockfile 在进程退出删 `.lock` 后，仍有 owner.json 却允许接管 | data root 与 workspace registry 同时将 owner.json 作为恢复核对屏障；`green-04-test.log` 与后续全检 PASS |
| `red-04-test.log` | model.dispatch 观察回调内取消后，transport 仍被调用一次 | 模型 transport 与 shell 最后放行前再 guard；`green-06-test.log` PASS，目标文件未创建 |
| `check-02.log` | 本地 Node 类型声明下 dynamic import 的 once 不匹配 | 使用 ChildProcess 公开 exit 事件 Promise；不是产品行为通过证据 |
| `check-03.log` | CLI SIGINT 落在 session owner 已取、storage 未开窗口，snapshot 读取不存在 DB，误判 unknown | 完成已受理空 session 的存储分配，只关闭、不启动 Harness；`green-07-test.log` 与 `check-04.log` PASS |
| `demo-01.log` | 崩溃 fixture 仍写宿主管道，断管可能使其结束；cleanup ESRCH 掩盖原测试异常 | fixture 在 readiness 后仅写实际文件；清理不能掩盖原失败 |
| `demo-02.log` | fixture readiness 仅证明 PID 文件存在，首个效果文件尚未产生 | readiness 改为真实 effects 文件；`demo-03.log` 的 7 场景 PASS，含宿主死后实际残留增长 |

原基线 `check-01.log` 31/31 PASS，后续补真实 CLI、最后放行与 owner 丢失等独立失效方式；`check-04.log` 34/34 PASS。合入 #16 后按依赖/实际接线变化另做组合检查，最终对应日志见 validation.json；不将机器/TUI 模拟检查当作真实 Terminal 人工接受。命令超时/崩溃场景的被测工作仍保留原失败/unknown，即使故障处理验证 PASS。

# #26 截止准入与结果归因修复

本修复承接 `74a91eac93c19e17e82a91a9ad38c3aaea023273` 的新增组合首败，不改写原决定、原失败或此前评审。对应规格：V6、I7、I8、E1、E5；沿用 ADR-0003 的同一受限边界。

## 原因与修复

原始 `selected source produces a content-bound executable and only an explicit new process observes it` 在 350166.185542ms 后失败。原计划 deadline 为 `2026-10-09T22:59:18.890Z`，check 容器 configuration.creationDate 为 `2026-10-09T22:59:35Z`。原边界保存了 `failed / timeout / started=true / terminated=true`；上层无条件枚举尚未生成的 `work/targets`，派生出 `unknown / ENOENT`。原 timeout 没有被删除；错误发生在准入和上层归因。

- `runRestricted` 接收原始绝对 `deadline`。分别在准备前、输入复制及计划持久化后的 create 调用前、create/configuration 后的 start 调用前检查 deadline 与 cancellation。准备不会将剩余额度夹成 100ms；实际执行 timer 取相对 timeout 与绝对剩余时间的较小值。
- 未启动结果明确记录 `not-started`、原因和 `admission` 阶段。没有 create 时 `terminated=false`，不声称停止了外部进程。create 已发生仍执行 stop、inspect、delete、absence；任何清理不确定仍为 `invalid / termination_unconfirmed`，原拒绝原因留在 `admission`。
- improve build、startup、direct check，以及 eval runtime/grader 传递同一绝对截止点。build 的未知清理状态优先于取消信号，不能因取消而把未知副作用改成确定取消。
- direct check 先保留实际 execution、输出与 cleanup，再处理产物。确定失败或取消且没有 `targets` 时保留原状态与原因；取得的部分产物和产物读取缺口分别记录。成功仍要求完整文件集和精确候选内容，code 0 但缺少 `targets` 不会通过。
- eval 未启动的截止拒绝归为 `budget-stopped`，取消归为 `cancelled`，余下 trial 留为 `not-run`。确定 timeout/cancel 不再因没有 bootstrap 产物而改成通用 preparation error；grader 未启动不产生确定判断。

## 验证与证据边界

本机证据目录：`/Users/nineofour/pi-durio-v1-run/evidence/repair-26-deadline`。`commands.json` 保存实际命令、结果和未采用的测试结果；`evidence-manifest.json` 保存交接时的文件清单和 SHA-256。

快速回归使用真实 submit/validation/eval/boundary 调用，但将容器 CLI 替换为协议 fixture。它们仅证明控制流、原文保留和截止准入，不作为真实 VM 隔离证明：

- 7 个 boundary 回归：staging/create/configuration × deadline/cancelled，以及不足 100ms 的执行剩余时间。原实现 7/7 RED，修复后 7/7 GREEN。
- 10 个上层回归：准备后拒绝、无 targets 的 timeout/cancel、终止未知、成功结果缺内容，以及 eval runtime/grader 的截止归因，全部通过。嵌套测试启动器曾继承 `NODE_TEST_CONTEXT` 而跳过子测试；那份表面 PASS 明确不采用。另保留一次取消用例错误假定全部发出字节已到达宿主的测试失败；最终比较实际取得与保存的字节，未虚构未收到输出。
- 真实 VM 的默认/构建资源检查与实际 timeout cleanup：2/2 tests，4 个 VM，全部确认终止；默认 1 CPU/512MiB，构建 1 CPU/1GiB、Node heap 768MiB，不扩大配置。
- 新 source happy-path：1/1，246140.769791ms，3 个 VM 完成并终止。既有大输出保留回归：1/1，2 个 VM，stdout/stderr 都按实际取得字节保留。
- 真实 offline eval：1 个 local-fix trial completed/PASS，加 1 个独立 grader，2 个 VM 完成并终止；4 次受控请求、56 known tokens、0 paid calls。实际 runtime 与 grader 的 plan 均持有同一绝对 deadline。
- 以上分组保持各自统计，不合成全套测试数。11 个真实 VM 均核对 stop/inspect/delete/absence；前后 inventory 都只有既有 `buildkit`。555 条 source-build 输入/编译器/输出记录及 123 个编译后测试/fixture 文件前后无漂移。

新的正常路径测试预算在执行前固定为 600000ms；旧 300000ms 计划及其首败原样保留。依据原完整路径耗时约 350s，为内容准备和正常路径留出约 250s 余量。这仅修改受控测试 fixture 的预先授权预算，产品不会自动延长用户 deadline。单次执行结果及 source-build 输入、编译器、输出和编译后测试身份见 `source-happy-path.tap`、`heavy-before-identity.json`、`heavy-after-identity.json` 与 `vm-outcomes.json`。

调用链覆盖与复用：本树不存在 `test/eval-runtime.test.ts`；真实 eval 已通过独立的 `real-eval-smoke.mjs` 执行当前产品及 grader。`test/eval.test.ts` 的计划/报告/预算逻辑、其余 improve 选择/写回/回滚实现、安装及其他业务模块未改，沿用协调者原 250 项 PASS。改动的 improve 成功链由 source happy-path 覆盖，失败且已有 targets 由大输出回归覆盖，失败且没有 targets 与准入失败由新负例覆盖；eval 新拒绝状态/准备后 cutoff 由四个调用链负例覆盖，成功链由真实 offline trial/grader 覆盖。

可复用 Linux runtime：`/Users/nineofour/pi-durio-v1-run/evidence/repair-26-deadline/linux-runtime`；`describeImproveRuntime` identity 为 `5957b89d214074d12353abb58bd88460cc2160e54943b8fc094896e246512d7a`。旧依赖来源 `issue-21/linux-runtime-05` 的 12,636 条文件/链接记录与新副本逐项一致，依赖 identity `05389876e7e6d1cadb3e6425a223a13ffecf962a85e6d336647734b883335f17`。lock SHA-256 为 `3a3dbf3d8a741cb5db4a132fa7f0d4151e3afdc497cd0708684bf30d86d0ba67`；自己的当前编译输出逐项一致，source-build SHA-256 为 `0559e34005b6b6f981af0b09877f4a8c4d7bcb15dc05e9ce21435370145d6886`。没有新下载/安装 Linux 依赖。后续候选仍须核对内容身份，不能仅因 Git SHA 更新就宣称重新生产过这些证据。

剩余范围：不声称 paid DeepSeek、用户日用接受、全套技术验收或首版完成；独立 review、集成及后续交付由协调者推进。其他已适用的 250 项原完整测试证据沿用，没有为收尾重跑全套。

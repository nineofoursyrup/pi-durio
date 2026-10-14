# LIVE-USD3-R3-01：完整 SSE 在 SDK 正常关闭时保留 usage

本次修复由 #30 真实批次发现，影响 #23 实际 `improve` 请求续行。施工基线为 `80b912a0d02b1dab7df8afc909fdd9359769ed07`；独立 worktree 为 `/Users/nineofour/.codex/worktrees/provider-terminal-repair/Durio`，branch 为 `codex/pi-durio-v1-provider-terminal-repair`。

## 根因与边界

旧产品 `9aed1af6ee3b156bb7354961496217aa5e64843e` 的真实 `improve` run `f05d3379-5950-4bfa-aebd-72dd671c4fc3` 在 seq 88 取得 usage 923 + 29 = 952 与完整 `data: [DONE]`。该原始块 SHA-256 为 `a6c66b38e6e0a7fd497a203795724446440c8cababf717e5702c64fc0bc3bbf8`；seq 89 的 SDK 事件也有 usage，seq 90 却被 host 结算为 `tokens:null,status:cancelled,reason:"undefined"`。合法 `evidence_summary` 返回后，下一请求被 `BUDGET_UNKNOWN_USAGE` 拒绝。

已核实旧安装与本 worktree 的 `openai@7.19.0` ESM/CJS streaming 文件及 `pi-ai@1.1.0` adapter 内容相同，见 [SDK 身份与只读回查](original-readback-and-sdk-identity.json)。实际 SDK 路径为 `chat.completions.create` → `Stream.fromSSEResponse` 遇 `[DONE]` 后退出迭代 → `_iterSSEMessages` 清理 → `createAbortableSSESource` 调用 `reader.cancel(undefined)`。正常终止未触发传入 `init.signal` 的 abort；旧 boundary 无条件将所有 cancel 归为未知。

修复只从已保存的原始响应字节识别完整 SSE 事件和精确 `[DONE]`；不借用 SDK 镜像 usage。只有 HTTP 成功、有效且一致的非负安全整数 usage、完整终止事件、无 abort、无显式取消 reason，并且 reader cleanup 成功时，正常消费端关闭才结算为 known/returned。EOF、cancel 与 error 共用原有一次 settlement 门；cancel 唤醒的 pending read 不冒充 transport EOF，已经取得的字节仍保留。

缺少 usage、缺失或不完整终止事件、冲突/非法 usage、SSE 错误、HTTP/transport 错误、主动取消、清理失败或期间 abort 仍保留 unknown reservation。支持跨块、LF/CRLF/CR 与多行 data；非 SSE JSON 保持原来的 EOF/unknown 行为，不新增 JSON usage 协议。

## 验证与首次失败

- 首次最小回归通过实际安装 SDK：先验证 SDK 报告 952、`cancel(undefined)` 且 signal 未 abort，再失败于 host known tokens `0 !== 952`。原始 [RED](first-red.log) 与 [身份](first-red-identity.json) 保留。外部目录另保存首次 RED 的源码和测试原文，已对照该身份哈希核实。
- 初轮受影响检查 `provider-boundary`、`runtime-provider`、`improve`、`eval` 共 26/26 PASS。之后因 reader cleanup 与已取得字节并发边界发生修改，保留 `cleanup-red` 和 `acquired-red`，重跑对应最终路径。
- 最终 [provider boundary 11/11 PASS](final-boundary-checks-r3.log)，含完成、分片、异常 usage、中断、清理错误、原文保留、重开持久化、一次结算及下一请求准入。
- 最终 [Pi SDK/runtime 2/2 PASS](final-sdk-runtime-checks-r3.log)：现有 `improve` 用例的 HTTP body 在 `[DONE]` 后保持开放，实际 SDK 正常关闭后，合法 `evidence_summary` 接续第二请求，28 known tokens、0 unknown；同时验证自动 compaction 共用预算路径。
- 使用旧真实响应全部 7 个原始块，通过相同安装 SDK 与最终 boundary 进行 [离线字节重放](original-replay-result-r3.json)：首请求 952、后续受控请求 7，两次各一条 returned settlement。只重放字节，不推理、不执行真实工具、不声称真实 improve 已成功。

所有本轮验证均无真实 provider 调用、无 VM 启动。依赖和 lock 未改变。全量 251 项未重跑；初轮仍适用的 eval EOF/错误路径、improve 权限/报告/预算限制、恢复边界等保留其通过证据，最后两次修改影响的 consumer-close 路径已重验。旧 #23 离线通过与旧 review 仅保留其历史适用性，不能作为本缺陷已经通过的证据。

## 构建与后续

最终 producer `npm run build` 成功；[构建身份](build-identity.json) 逐项核实 169 inputs、140 compiler entries、246 outputs。可供集成方复用的 sourceBuild：

`/Users/nineofour/.codex/worktrees/provider-terminal-repair/Durio/dist/execution/source-build.json`

SHA-256：`8f4ce2a273559d871b76c1cf14971a0df048d7f86b8216ff45b3d8dd2a710821`。

完整新证据目录：`/Users/nineofour/pi-durio-v1-run/evidence/repair-provider-terminal-r1`。其中保存首次 RED、后续所有失败与通过、原始响应副本、只读回查身份、最终 source-build 副本及离线 replay 脚本/事实。旧 r2/r3 数据、清单、构建、安装和零候选报告未修改；旧数据库 `mode=ro` 回查前后哈希相同。

产品源码改变，需由集成方形成新的 source/build/install candidate，并独立复核。本修复不把旧真实批次改标为新候选，不创建用户优化候选，不代表新付费启动授权、日用接受、main/release 或 issue closeout。请求的执行模型/推理级别为 `gpt-6-astra` / `xhigh`；工具没有返回可核实的实际 backend 身份，不能证明该身份。

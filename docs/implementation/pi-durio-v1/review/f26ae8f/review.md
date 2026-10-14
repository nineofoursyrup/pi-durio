候选 `f26ae8f4b8039608a1fa796e1c69da4d8173d112` / tree `ceebaeb3805dd8f2eeab948792f88e6f9a0ba2e0` 的 focused review 完成：**Standards PASS，Spec PASS**。范围仅为 LIVE-USD3-R3-01 修复及旧证据适用性；0 项硬问题，1 项非阻塞命名建议。

**Standards（独立 focused pass）**

PASS：未发现文档标准硬违规。生产改动留在已有 provider boundary；raw block 在解析和限额判断前保存，使用原 Evidence/budget settlement，未引入第二账本或修改旧结果。两份测试覆盖真实安装 SDK 关闭、合法 improve 工具后续请求及关键异常；8 份证据文档保留首败并明确候选和验收边界。first-red.log 的原始尾空格不作格式问题重写。可选 possible Mysterious Name：`frameBytes` 实际累加 `line.length`（UTF-16 code units），建议改名并注明单位；原 raw 字节上限独立存在，此项不阻塞。

可选建议定位：[src/provider-boundary.ts:64](/Users/nineofour/Durio/src/provider-boundary.ts:64)，`this.frameBytes+=line.length`。这是 smell 判断，不是已证明的行为缺陷；其余 baseline smells 未在本 diff 中形成需报告的问题。

**Spec（同一独立 reviewer，单列结论）**

PASS（本次修复范围）：完整、有效 raw SSE usage 与 DONE 经过成功 reader cleanup 后，正常 SDK close 可保存 known/returned，并允许下一请求；HTTP 错误、异常/缺失 usage、不完整 terminal frame、真实 abort/显式 reason、cleanup 失败或期间 abort 均保持未知且受预算阻断。仅观察到 usage 或 DONE 不触发提前结算，pending pull 不把 cancel 唤醒误当 EOF，已取得字节先留存，原一次 settlement 门不变。LF/CRLF/CR、跨块和多行 data 有证据；非 SSE 不新增 usage 推断。符合 E1/E2/E6、V6/V7、I1，未发现缺项、错误实现或额外 scope。真实 improve 旧失败仍未被真实新执行解决；该门槛属于后续独立授权批次。

依据：[E1/E2](/Users/nineofour/Durio/docs/specs/pi-durio-v1-spec.md:68)、[E6](/Users/nineofour/Durio/docs/specs/pi-durio-v1-spec.md:73)、[V6/V7](/Users/nineofour/Durio/docs/specs/pi-durio-v1-spec.md:86)、[I1](/Users/nineofour/Durio/docs/specs/pi-durio-v1-spec.md:93)。已取得 raw bytes 始终先保存；host ledger 没有从 SDK usage 镜像回填。

**验证与适用性**

独立核对 169 inputs、140 compiler entries、246 outputs，0 mismatch；sourceBuild 为 `8f4ce2a273559d871b76c1cf14971a0df048d7f86b8216ff45b3d8dd2a710821`。旧安装的 OpenAI/Pi adapter 与当前相关依赖字节一致，生产变化仅 `provider-boundary.ts`。

复用最终 boundary **11/11**、Pi runtime **2/2**、原始 7 块离线重放（952 → 7）的既有通过证据；初轮 26/26 只复用仍适用部分，不把重叠组相加成新的全量 PASS。此次仅新增有必要的原始响应兼容性读回：旧四类 PASS 的 **25 次真实响应全部匹配**新 parser 完整 terminal frame 和旧 host known usage；native composition **3 次合成预算响应 / 42 tokens** 也匹配。所有被读数据库前后 hash 相同。

| 旧证据 | 对本次修复的有界结论 |
| --- | --- |
| local-fix / multi-file / regression / no-change | 保留旧真实 PASS；原 fixed case、grader 与执行路径未改，全部原始响应兼容新 parser，可复用其行为证据。执行候选仍是 `9aed1af`，不是新候选真实 rerun。 |
| native long-session | 62 个原始 execution.config 均无 providerBoundary，124 次 synthetic / 0 real；未改交互、工具、显示、退出路径可复用。 |
| native composition / readonly follow-up | 原 7 次 synthetic 中 3 次 budgeted improve 响应兼容；未改选择、fixture 回归/写回、查询/原文路径可复用其自动流程证据。 |
| native 时间、RSS、增长及旧 package/source 大小 | **仅保留为 `9aed1af` 实测**；不得改标新候选或据此声称资源/时序等价。新 source/package inventory 由主协调者另行生成。 |

原 r2 multi-file `error / unknown`、r2 未运行项、r3 improve `failed / incomplete / UNKNOWN / 0 candidates`、首批 native composition 失败都保留。自动 native workload 不新增人类 IME/复制/鼠标/小窗口或日用接受结论。

完整定位、hash 与每案例决定见 [review.json](/Users/nineofour/pi-durio-v1-run/review/provider-terminal-repair-r1/review.json)、[evidence-applicability.json](/Users/nineofour/pi-durio-v1-run/review/provider-terminal-repair-r1/evidence-applicability.json)、[独立原始块读回](/Users/nineofour/pi-durio-v1-run/review/provider-terminal-repair-r1/readonly-applicability-result.json)。新 paid harness 未评审；未执行 provider、OS VM、Terminal、产品测试或新构建，未读取凭据、修改产品/Git/state/旧证据。本报告可输入新的 improve-only 提案，但**不授予付费执行授权**，不构成整版验收。

请求模型/推理：`gpt-6-astra` / `xhigh`；独立 fresh-context reviewer 的实际 backend 身份无可核实 attestation，保留 **NOT_ATTESTED**。

Standards：0 hard + 1 optional，最严重为非阻塞命名建议；Spec：0 findings，无已发现缺陷。

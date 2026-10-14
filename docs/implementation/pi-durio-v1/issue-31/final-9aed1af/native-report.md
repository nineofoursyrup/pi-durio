# 最终候选首批 native 测量：保留失败

候选 `9aed1af6ee3b156bb7354961496217aa5e64843e`，批次 `2026-10-10T05:34:12.983Z` 至 `2026-10-10T05:41:18.503Z`。总体 **MEASURED_WITH_FAILURES**，#31 技术验收仍为 **PARTIAL**；#32 日用接受未完成。新增记录不覆盖 `partial-summary.json` / `partial-report.md`。

| 步骤 | 结果 | 退出码 | TTY 前后 |
| --- | --- | --- | --- |
| idle-1 | MEASURED | 0 | unchanged |
| idle-2 | MEASURED | 0 | unchanged |
| idle-3 | MEASURED | 0 | unchanged |
| long-session | MEASURED | 0 | unchanged |
| composition | FAIL；无 result.json | 1 | unchanged |
| readonly-data | NOT RUN，前一步失败即停 | — | — |

计划 6 步，实际执行 5 步。全部已执行步骤 TTY 相同，`ttyRepairNeeded=false`。`composition/failure.json` 保留 `phase=analysis`、`Error: IMPROVE_REPORT_NOT_FOUND`、2 次合成请求；屏幕记录停在 improve 分析中。没有 `selection-result`、decision template 或 validation 目录，不能宣称选择、隔离回归或正式写回通过。只读查询 30 次和完整导出 5 次是未运行计划；本批次 `sourceUnchanged` 为未测量。

## 环境与身份

实际 `Apple_Terminal`，环境版本 `488.7`，112×35，profile `UNKNOWN`；所有原生步骤的计划尺寸一致。Node `v26.8.2`，路径 `/opt/homebrew/Cellar/node/26.8.2/bin/node`。原批次验证完整 14,230 项安装快照；本次只读回核 config、harness、产品入口与 sourceBuild，并与固定安装 identity 逐项对应，没有再次执行 build 或整树安装验证。config SHA-256 `d044ef17458909e07af31dd35d0928caf1a875aad88cd8fba65c140423bb77d7`；sourceBuild SHA-256 `0559e34005b6b6f981af0b09877f4a8c4d7bcb15dc05e9ce21435370145d6886`。具体绝对路径、bytes、SHA-256 见 `native-summary.json`。

记录的一分钟 load average 范围 2.747559–3.937500，不表示无其他主机活动。安装预检读取会预热文件缓存，未清系统缓存。

## 三次空闲启动

| 次数 | firstFrame performanceMs | 观察空闲秒 | RSS min / median / max MiB | 样本数 |
| --- | --- | --- | --- | --- |
| idle-1 | 279.996375 | 31.031 | 89.344 / 89.344 / 89.375 | 31 |
| idle-2 | 278.713667 | 31.036 | 89.719 / 89.750 / 89.781 | 31 |
| idle-3 | 278.249625 | 31.030 | 89.719 / 89.719 / 89.734 | 31 |

firstFrame 中位数 278.713667 ms。该字段是进程内 `performance.now()` 到首次含正常标题的 stdout 发射记录，包含模块导入和宽度门控；不是 OS 进程创建到完成、Terminal 窗口启动或像素呈现时长。每次 nominal 1000 ms 采样，实际相邻间隔和完整原始序列可从 JSON 引用复核。三次均无 provider 尝试、首帧后输入字节为 0，width calibration 为 `measured`。

## 连续任务与资源

60 轮由 read / edit / check 各 20 次组成；harness 在大输出前断言已运行至少 300,000 ms。第一轮文本注入至大输出文本注入间隔 310456.625333 ms，包含任务、每十轮 history/navigation 与节奏等待。原始 `longSessionDurationMs=317491.93525` 还包括大输出、下一普通任务及 exit，不能写成 60 轮专用时间。

已核对 62 个 `task.accepted` / 62 个 `run.closed`，run ID 与 62 条 round 结果一致，全部 completed；124 次合成请求，0 次真实 provider 请求。1 MiB 输出为 1,048,576 bytes、64 chunks，实际与预期 SHA-256 均为 `8e3c8e0abdb626d27f3982beafe83f34f2141c86223bd1b4d3cce74a77181502`；下一普通 read 任务完成。

宿主 Node 共 256 个 RSS 样本：min / median / max 为 90.172 / 280.758 / 300.312 MiB。首样本 90.172 MiB，末样本 300.312 MiB；数据表现为本次负载期间增长，不能由这段观察断言泄漏或稳定平台。nominal 间隔 1000 ms，实际 min / median / max 为 999.437708 / 1001.422041 / 4085.711750 ms。此 RSS 排除 Terminal.app、子进程与采样间瞬时峰值。各阶段 RSS 与存储 checkpoint 均在 JSON 单列；最终逻辑存储 42,098,044 bytes，按路径分配量 51,716,096 bytes，不是 APFS 唯一物理空间。

## 组合流程已知边界

90,000 个 z 的原响应已按 object SHA-256 回读保留；`compaction.finished` 实际为 `applied`，committed summary 与 `/compactions` frame 存在。后续 improve 报告轮询抛出上述错误，使本组合步骤失败；缺少完整 analysis、selection、隔离回归、fixture 正式写回及下一任务结果。当前 fixture `math.mjs` 仍等于声明的 before 字节。本批次没有人类 e / s / Enter 接受，不产生中文 IME、复制、鼠标、小窗口或日用接受的新结论。

## 保留与后续

真实 DeepSeek 代表任务、真实 improve 人类选择闭环与 #32 日用接受仍分别待证；真实付费授权或后续准备不改变本批次结果。原 npm ls / 消费端 npm ci 首次失败和全部旧候选报告保留。

原始入口：[batch result](/Users/nineofour/pi-durio-v1-run/evidence/issue-31/final-9aed1af/native/result.json)、[首次失败](/Users/nineofour/pi-durio-v1-run/evidence/issue-31/final-9aed1af/native/composition/failure.json)、[长会话 result](/Users/nineofour/pi-durio-v1-run/evidence/issue-31/final-9aed1af/native/long-session/result.json)。新增完整引用及 hash：[native-summary.json](/Users/nineofour/pi-durio-v1-run/evidence/issue-31/final-9aed1af/native-summary.json)。`native` 目录没有被本次归档写入。

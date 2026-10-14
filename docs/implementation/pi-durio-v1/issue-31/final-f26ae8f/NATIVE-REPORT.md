# 当前原生测量与恢复回读

候选 `f26ae8f4b8039608a1fa796e1c69da4d8173d112`。真实 Apple Terminal 批次 `2026-10-10T11:07:32.078Z → 2026-10-10T11:14:35.743Z`；六步均正常退出、TTY 前后一致、无需修复。完整值、内容引用、hash 和范围见 [native-readback.json](native-readback.json)。自动注入后的结果仅支持原生集成，不是新人工 IME/复制或日用接受。

环境：`Apple_Terminal` / `488.7`，`120×30`，profile `UNKNOWN`，字体 UNKNOWN；Node v26.8.2。一分钟负载范围 3.140625–4.750488。完整安装预检已读取 14,230 条清单，未清 OS 缓存。

| 空闲重复 | firstFrame ms | 空闲秒 | RSS min / median / max MiB | 首帧后输入 bytes |
| --- | ---: | ---: | --- | ---: |
| 1 | 281.224333 | 31.037 | 89.859 / 90.406 / 90.438 | 255 |
| 2 | 278.748834 | 30.045 | 89.500 / 89.500 / 89.531 | 0 |
| 3 | 279.687500 | 31.036 | 89.984 / 90.016 / 90.047 | 0 |

三次空闲 firstFrame 中位数 279.687500 ms，均宽度实测成功且 0 provider 尝试。firstFrame 是包含模块导入/宽度门控后的 stdout 发射时间，不是像素呈现、Terminal.app 启动或进程创建耗时。首轮输入字节可能包括终端/焦点响应；未保留对应原始输入，因此不能仅凭计数证明或排除人工输入。

60 轮 read/edit/check 各 20 次；首轮注入至大输出注入 309.829s，满足至少五分钟。含 1 MiB 大输出、下一普通 read 和退出的时长为 316.655s。已只读核对 62 个 task.accepted、62 个 run.closed 及一致的 run IDs；124 次合成请求，0 次真实 provider 请求。大输出 1,048,576 bytes / 64 chunks，SHA-256 `8e3c8e0abdb626d27f3982beafe83f34f2141c86223bd1b4d3cce74a77181502` 与预期相同，下一任务正常完成。

RSS 共 256 个样本，min / median / max 为 90.469 / 280.859 / 289.656 MiB；首/末为 90.469 / 289.656 MiB。nominal 1000 ms，实际采样间隔 min / median / max = 999.443 / 1001.482 / 3864.940 ms。本次观察为增长过程，不能断言泄漏、稳定平台或小时级稳定性；不含 Terminal.app、子进程和瞬时峰值。

| 数据 checkpoint | 逻辑 bytes | 按路径 allocated bytes |
| --- | ---: | ---: |
| storage-empty.json | 0 | 0 |
| storage-round-1.json | 4,521,737 | 5,222,400 |
| storage-round-10.json | 6,822,961 | 8,839,168 |
| storage-round-20.json | 10,608,327 | 14,057,472 |
| storage-round-30.json | 15,695,299 | 20,574,208 |
| storage-round-40.json | 22,063,987 | 28,389,376 |
| storage-round-50.json | 29,719,809 | 37,429,248 |
| storage-round-60.json | 38,675,563 | 47,824,896 |
| storage-large-output.json | 41,117,087 | 50,610,176 |
| closed-result-final | 42,099,297 | 51,720,192 |

当前独立数据根初始为 0，最终保留原文的逻辑增长为 42,099,297 bytes。SQLite、objects、durable sessions 分项与每份完整 inventory 见 JSON。allocated 不是 APFS 唯一物理占盘。

| 只读方法 | 次数 | min / median / max ms |
| --- | ---: | --- |
| queryEvidence | 10 | 0.454 / 0.488 / 0.649 |
| queryHistory | 10 | 11.477 / 12.299 / 13.128 |
| readEvidence | 10 | 0.668 / 0.744 / 1.067 |

5 次完整输出取得与写入各 1,048,576 bytes，hash 一致；min / median / max = 7.635 / 8.516 / 9.142 ms。30 次只读调用和 5 次导出前后完整源 inventory 一致。导出组合公开分页读取、JSON/base64 解码和写入直到 close，未 fsync；不是孤立磁盘写延迟或 CLI 整体导出能力。观察/哈希开销未分离，也没有关闭 tracing 的对照。

N1 冷恢复为 PASS：当前恢复面板经 0 次普通 Down 后显示明确结束操作；保存恢复报告、结束旧任务、保留原 aborted 原文、仅一个全新任务 completed，原 follow-up/compact 两项保持 frozen；无 width timeout/重试/runtime error，最终 cleanup confirmed，raw/stty 恢复。该步 2 次合成请求（含 headless fixture 准备），0 provider、0 VM；逐项事实和屏幕/输入原文均保留。

旧 native composition 首次 IMPROVE_REPORT_NOT_FOUND、后续针对性修复、旧 9aed 计时，以及 #16 r5 人工退出首败继续留在各自原目录。本批没有覆盖、删除或重标它们。#31 的技术证据结论待独立审查/协调验收，#32 日用接受未由这些自动结果推定。

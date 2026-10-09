# #16 适用验收：真实 Terminal 只读请求与输入

结论：**ACCEPTED_FOR_INTERNAL_DEPENDENCIES**。产品候选 `231f206e859f0ed889a69d943b9c17f92a20cf79`，集成 merge `f17ddfbe9fb8b07a6ddde46a42cb35560b07687c`；对应 [完整身份与证据哈希](acceptance-r6.json)。这完成 T06 的纵向路径，允许内部调度 #17/#18；GitHub #16 保持 OPEN。

| 适用要求 | 证据与结论 |
| --- | --- |
| 全屏单列、真实状态、有界输出与详情 | r5 N1–N4 人工 P，实际持久记录/分页回归；r6 正常只读请求 completed，输出 Fruit count: 7，headless 同 run 一致 |
| IME、宽字符/字符簇、粘贴、多行、菜单、复制与焦点 | r5 C1–C3、N1–N4 原生 P；r6 只改变协议回包先于用户动作观察的次序，渲染/编辑/宽度/复制路径未变，按[适用性](confirmation-repair-r6.md)沿用，未伪装成 r6 重测 |
| 小窗口、过小提示及恢复 | S3 原生 P；单项 GRID_INPUT P，加用户明确补充确认及同尺寸 xyz/F2/Esc 日志，实测最小 40×12；更小 39×11 提示与清草稿已验证 |
| 同键确认、草稿与取消规则 | r6 首次运行中 Ctrl+D 516ms，intent exit、cleanup confirmed；空闲 Ctrl+C 589ms，原样草稿、零任务；23/23 受影响检查覆盖 800ms、真实其他键、组件焦点/弹层/运行场景、resize 失效和校准等待输入顺序 |
| 中止、退出与终端清理 | r5 STOP/ESC 原生 P；r6 正常退出及可捕获故障 P，raw/stty 与视觉原缓冲区恢复；保留 remote unknown，与本地 confirmed 分开；不可捕获退出恢复说明沿用 README |
| 真实 Terminal 与 headless 相同持久结果 | r6 completed、运行中退出、fault 均从独立 headless 读取同一结果；独立 npm 安装 smoke 和 12,704 文件核验通过 |

[本轮人验记录](terminal-r6-feedback.md)与[r5 原记录](terminal-r5-feedback.md)均保留。r3/r4/r5 原 FAIL、曾经 S2 U、尺寸误填 P 及原 UNKNOWN 汇总没有改写；补充确认是新的证据记录。OS 窗口切换焦点报告作为额外探查仍 UNKNOWN，不声明已通过，也不扩大 T6 的组件/弹层/运行场景合同。

确定性证据复用 r5 的 65/65 组合与 8/8 影响检查，r6 新跑 23/23 受影响检查及 1/1 清单检查；合并 tree 与交接 tip 一致，后续仅文档变化。没有为了验收阶段重复未变化的全套测试。

真实模型付费验收、完整 coding 队列/恢复 UI、最终独立评审、#31 技术验收和 #32 本机日用接受仍属后续范围。本条不授权或表示 main 产品合并、release、关闭票。

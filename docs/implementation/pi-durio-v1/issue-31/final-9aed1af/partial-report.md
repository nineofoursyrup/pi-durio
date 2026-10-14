# 固定候选本地测量（部分技术证据）

候选 `9aed1af6ee3b156bb7354961496217aa5e64843e`；source/build/package/安装身份见 `freeze.json`。#31 尚未完成，当前没有完整技术验收或日用接受结论。

环境：macOS 27.2 / MacBookPro18,1 arm64，32 GiB RAM，Node v26.8.2。执行时系统一分钟负载范围 12.32–21.34；只保证本轮 VM/build/测量不互相重叠。

| 项目 | 实际观察 |
| --- | --- |
| 产品源码 | 80 文件，7481 物理文本行 |
| 跟踪脚本 / 测试 | 2557 / 4529 行；其他类别见 JSON |
| 外部测量 harness | 8 文件，599 行，单列，不并入产品源码 |
| 压缩分发包 / 完整独立安装 | 19,221,238 / 90,150,168 bytes |
| help / 空数据历史查询 | 各 7 次；中位数 211.40 / 206.31 ms；14 次正常退出 |
| 连续 headless 任务 | 60 轮 read/edit/check 用时 301.86s，另有 1 MiB 输出和下一普通任务，共 62 次完成 |
| RSS | 空闲中位 77.70 MiB；连续任务中位 262.16 MiB；全程采样峰值 275.75 MiB |
| 只读查询 / 完整输出导出 | 30 次 / 5 次；每份导出 1 MiB、hash 一致，完整源数据 inventory 未变 |

完整原始时长、RSS 序列、负载、阶段存储增长、依赖/native 文件、参数和内容 hash 均保留在本目录，汇总入口为 `partial-summary.json`。原始大输出完整保留；只读查询与导出通过公开 API 执行。

这些结果没有预设数值验收阈值。启动未清系统缓存；RSS 仅采样宿主 Node，不含所有子进程或瞬时峰值；五分钟观察不证明数小时稳定。导出时长包含读取、解码、写入与 close，未 fsync，不是孤立磁盘延迟或 tracing 开销。

安装兼容性：离线首次/重复 npm install、CLI 和 12 个公开 import 通过；npm 11.19.1 的 bundled file npm ls 及消费端离线 npm ci 保留 FAIL。详见 `../../delivery-9aed1af/dependency-report-disposition.json` 和包诊断，不能把失败改记为 PASS。

待完成：真实 DeepSeek 代表任务与 improve 闭环、最终 macOS Terminal 原生组合和资源记录、完整技术验收、用户自己的日用试用与明确接受。付费调用仍为 0。

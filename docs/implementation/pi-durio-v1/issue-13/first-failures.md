# #13 首败与修复链

原始日志保留在 `/Users/nineofour/pi-durio-v1-run/evidence/issue-13/`，不覆写首败。

| 原始记录 | 事实 | 处理及复核 |
| --- | --- | --- |
| `red-01-coding.log` | TypeScript 没有 runCodingTask 导出 | 新入口复用既有 runTask/Harness，接公开四工具 |
| `coding-01.log` | 真实修复/检查已执行；测试错误地对 base64 记录匹配明文 | 修正测试按 encoding 解码；首次日志保留 |
| `red-02-ownership.log` | 第二 workspace 写入者没有被拒绝 | 增加独立用户级 workspace registry/owner；跨 data root/session/别名/嵌套与第二进程验证 |
| `red-03-summary.log` | 缺 tool.summary 派生记录 | 追加有界摘要，保存失败仅降级；read/coding 均覆盖 |
| `red-04-gap.log` | 实际 ENOTDIR 故障停止了 shell，但缺可写下的 gap 记录 | 原文失败尝试追加 evidence.gap；不可写时仍保留 unknown，不假定标记成功 |
| `red-05-user-changes-git.log` | 损坏 Git 根被降为非 Git；现有文件能盲写/覆盖新编辑 | Git 身份未知阻断；现有文件要求观察，记录及核对前像，拒绝变化 |
| `check-01.log` | 19/20；取消测试期望只有 3 行，实际在取消完成前还取得第 4 行 | 之前 PID 消失及返回后产物稳定断言已通过。修正为连续完整前缀、取得字节/实际产物边界；保留竞态期间新取得原文，不丢弃第 4 行 |
| `red-06-sequential.log` | 命名为 red 的检查实际 PASS：上游已保护同轮文件别名编辑 | 原样保留 PASS，不编造首败。coding 另外显式使用公开 sequential 配置涵盖 file/bash 的同轮顺序 |
| `red-07-project-data-root.log` | Git 子目录启动时允许数据根落入同仓库其他目录 | 在 mkdir 前按整个 Git root 验证，拒绝时不创建项目内目录 |

`demo-01.log` 对应中途精确候选，仍保留；最终代码若有变动另写新 demo 日志/目录，不将旧 artifact identity 改成新候选。演示的 baseline check 失败是固定 fixture 的真实首败；恢复后的通过另存，不替换 baseline。

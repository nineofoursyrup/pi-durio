# 首败与修复

原日志位于 `/Users/nineofour/pi-durio-v1-run/evidence/issue-20`，保留原字节，不用后来的通过覆盖。

| 记录 | 首败 | 修复与后续检查 |
| --- | --- | --- |
| `build-r1.log` | 测试对 unknown result 未收窄；误把 Pi queued summary 的 `SubmissionRecord.type` 写成 `summary`。 | 核对安装的 Pi 1.1.0 公共类型与 compaction 实现，使用公开 `write` submission；按结果接口收窄。没有修改 Pi 类型或私有表。 |
| `storage-r2.log` | 5/8 通过；macOS `/var` 临时目录别名被严格路径校验拒绝。 | 新建 fixture 和临时解压根先取 realpath。仍拒绝附件 symlink；没有放宽到跟随任意别名文件。 |
| `storage-r4.log` | 7/8 通过；独立附件还原实际字节正确，但对象属性排列与目录枚举产生的排列不同，触发错误的内容比较。 | 用排序后的 `[path, sha256, bytes]` 三元组验证身份，不依赖 JavaScript 属性顺序；9/9 r5 通过。 |
| `check-r5.log` | 无失败，91/91。 | 合并 #17 前的完整项目必需检查。 |
| `merged-r6.log` | 无失败，26/26。 | 合并 #17 后的 storage、TUI、history-view 组合，含真实新增的释放安装依赖来源和附件 alias 行为。复用仍适用的全量结果。 |
| `partial-resume-first-failure-r7.log` | 新回归首败：附件 A 已完成、附件 B 中断、session 尚未开始；同操作续作误报 `STALE_MANAGEMENT_PREVIEW`。 | 只排除当前 operation 自己追加的 availability receipt 对剩余来源集合的影响；其他新来源和保护仍必须阻断。`storage-r8.log` 11/11，独立 r2 安装实际续作和外部新引用拒绝均通过。 |

最终产品候选为 `68fb251623326b1a6357e7efb8b2602ecbc74f3e`。r2 只改变 `commitCleanup` 的同操作 receipt 比较，以及回归测试/演示脚本。r1 的归档、还原、固定保护、磁盘故障、未知格式、WAL 迁移和原判断不变的确定性结果仍适用；原 r1 candidate、fixture、日志都保留。r2 重新打包安装、核对源码/编译/依赖身份，并实际执行新受影响路径，没有仅因候选编号变化重复全场景。

测试/演示中注入的 ENOSPC、after-delete receipt 缺口、after-stage 中断与未知格式，是有意保留的故障输入。`partial`、失败部分、`absent-after-recorded-intent` 和原任务检查失败分别保留，不能把后来的续作通过写回原失败。

# #18 历史查询、用量与固定证据

实现范围：沿用 host.sqlite 的不可变记录引用和 content-addressed 原文，增加只读投影与明确的固定/重估管理操作。没有新 trace/usage 账本、后台遥测、Harness 打开或付费调用。旧宿主事实和用户决定不是可删的索引；索引直接按限定快照重建，不存在需要删除宿主库的“重建”命令。

## 入口与身份

`pi-durio history --filter '{"status":"failed"}'` 返回摘要，`--cursor JSON` 延续相同筛选和 `snapshot`。过滤支持 project、session、from/to、kind、taskType、status、reason、version、provider、model、completeness；时间窗为受理时间 `[from,to)`。字段没有事实时保持 null。project 以当前宿主登记 ID 或 workspace 事实为范围，不凭相同 remote 合并项目。

`evidence --run ID` 分页列记录，`evidence --evidence e1:SEQ:SHA256` 分片原文，`--decoded` 读取原始取得的 base64 输出块，结果仍以 base64 表达精确字节。`trace --run ID` 追模型/工具尝试、实际 dispatch 记录与终止、相关检查/恢复/派生引用；`usage --run ID[,ID]` 返回去重范围和缺失。分页接受 `--after`、`--snapshot`、`--limit`；原文接受 `--offset`。`--format text|json` 展示同一个返回对象。

证据身份为 `(dataRoot, e1:seq:bodySha256)`；对象身份为 `(sha256,bytes)`，时间和路径不代替身份。长原文每次最多 16 KiB，核验全部内容 hash 但只保留一个切片。元数据页最多 50 条，底层按 32 行拉取。History 每次最多扫描 500 项受理任务，仍有范围时返回 next；空页不证明没有发生。游标固定全部事实的上界，后来的状态/运行链接不能偷偷进入旧页面。查询报告 snapshot/current、陈旧状态、缺口及覆盖限制。

TUI `/history` 和菜单“查询历史（只读）”共用查询；`/history {JSON筛选}` 可限定范围。方向键选择，Enter 下钻，n/p 翻页，PgUp/PgDn 滚动，b 上层，Esc 关闭；记录页 t 查看尝试、u 查看用量，原文页 d 查看脱敏派生。列表选择在窄窗内保持可见。历史面板没有 submit、compact、恢复或固定写操作；不改当前 runId/sessionId、输入草稿、活动任务或停止目标。退出、宽度校准、到达时输入绑定、原生键码、光标和终端生命周期机制沿用 #16/#17。

## 受理、运行与原事实

消费 #17 的 `readAcceptedTasks/readQueue`，共享来源 commit `01f2d3a562b12a9917b3db1dc8111ea2717d386f`、修复 `ca972e836d2abcc60d89467a522c556bf45127c5`（本分支分别 cherry-pick 为 `6ce9cb1`、`507a144`）。这些共享 commit 不表示 #17 已验收。

pending/frozen/withdrawn follow-up 有独立 taskId、不可变 target 和受理时间，runId/execution 保持 null，之后实际执行的链接独立记录；不会继承 target run 的完成/失败或费用。普通任务在受理后启动前失败，则保留自身失败/采集缺口与 admission 证据，同时仍没有 execution 链接。steer 不增加任务。恢复结论展示为追加事实，原关闭结果没有被覆盖。

`complete` 表示实际取得内容的保真范围；源没有终止返回、collection-gap、显示 truncated、派生 redacted、archived、cleaned、corrupt、temporarily-unreadable 分开表达。按稳定 ID 查看能检测当前对象损坏或缺失。归档/清理实现追加 `evidence.availability` 的 sourceId 或 sha256 与 state，不能改旧判断；本票没有执行归档或清理。归档尚未还原时明确要求还原，不能将一个归档引用宣称为可读原文。

## 用量与价格的来源

`queryUsage(root, runIds, through)` 读取原 `usage.projection` 与公开 storage 扫描保存的 `durable.closed-snapshot`，每个 session/conversation 取最新已取得的 committed pi.usage。它不把多个累计快照相加、不对 run 做前后差，也不把 model.response 再加入账本。多个 run 共用范围时 runId=null，作为未归属会话量；原始值及 documentId/来源记录仍可查。

trace 的实际请求以每条 model.dispatch 的证据 ID 计数，同一 stream 包装的多次 fetch 各有身份；HTTP 头不结束流 span。只有真实 model.response/tool.result/tool.error 才有终止时间；丢失终止保持 unknown。provider/SDK 未暴露的内部操作不猜测次数。compaction 的 purpose 和新尝试来自原 intent，没有另写调度器。

已知 input/output/totalTokens 继续保留，reasoning 是 output 子集，不重加。整次 usage 未取得时数值为 null。Pi 归一化的 cacheRead/cacheWrite 零值，只有相同已提交范围的原 provider usage 事件支持时才输出为已知零；未返回分类保持 null/partial，正的已知部分保留。categorySources、categoryCoverage、requestCoverage 和缺口分别指出依据；这些是分类可见性的核对，没有重新累计原 provider usage。未计入费用的失败/重试请求使覆盖不完整。单次查询限 50 个请求 run、500 个 usage 文档、4 MiB 投影内容、10,000 个关联 run；超过时明确要求缩小范围，不悄悄少算。

`estimate --id ID --run IDs --price JSON [--snapshot N]` 用声明的 version/source/currency/effectiveAt/perMillion 价格生成追加 `usage.estimate`，未知分类及原工具/目录估算分别保留。只有 USD 估算，不能称作账单。相同 ID/输入只读回已有估算，新的价格用新 ID，不覆写旧值。

## 给 #20/#21/#24/#27 的公共接缝

从 `pi-durio/query` 或对应源码模块使用：

- `queryHistory/queryEvidence/queryAttempts/readEvidence/queryUsage`：同一只读入口；任何查询都不获得 Harness 或自动恢复能力。
- `scopedEvidence(root, {runIds,through,maxBytes,purpose,destination})`：返回只有 `read(id,{offset,limit})` 的能力闭包，不暴露 root/path/shell。必须先限定摘要范围再选择记录，最多 32 KiB 总片段预算、16 KiB 单片。来源、快照、目标 provider/model（模型目的地必填）、遮蔽原因和截断位置都在派生结果中。历史指令样材料不能扩大权限。已知秘密/指令样或无法安全解释的片段整段遮蔽；原始字节块因边界上下文不完整，派生默认遮蔽，可改选完整文本结果。模式检测不声称覆盖所有秘密。派生不改写原文。
- `export --run IDs --evidence IDs --purpose TEXT --destination FILE`：显式导出选定的有界派生结果与来源到新本地文件（0600、拒绝覆盖）；没有隐式外发。`derive` 返回相同对象。
- `fixEvidence(root,{id,sources,dependencies?,purpose})` / `fix`：先获得既有 data-root owner；在事务提交固定事实前，核验选定记录所属 run 截至 snapshot 的全部已取得原文、执行/初态/检查/恢复引用及声明依赖。运行安装依赖按已保存 inventory 的 hash/长度实际保留到 objects，缺失或变化直接失败。只存在链接不成功。上限 20,000 个对象/源记录，超过明确失败。它不是整个项目快照或未来执行保证。
- `verifyFixed(root,fixedEvidenceId)`：重新核验 manifest 与全部实际对象。相同 fixation ID 重复调用也先核验，内容缺失或损坏不会返回旧成功。
- `iterateFixedDependencies(root)`：有界迭代固定记录 body、manifest 和全部受保护 BlobRef，可出现重复；#20 清理必须消费并保护它们，保留 host.sqlite 中宿主独有事实。任何缺失/损坏 manifest 要停止相关清理，不可当作没有保护。`fixedDependencies` 是最多 20,000 个唯一对象的便捷列表，更多使用迭代器。不会自动解除固定。

pending 的 source 是原 admission/control.accepted 记录（在原 target run 的 scope 内）；固定覆盖该受理快照及目标运行的必要事实，不创建 placeholder run，也不承诺保护未来尚未产生的执行内容。eval fixture/outcome、improve 候选把其真实内容/必要依赖先写入既有 Evidence 引用，再通过同一 `sources/dependencies` 固定，不引入新的特定对象账本。

## 验证、首败与测量

外部不可变日志与示范目录：`/Users/nineofour/pi-durio-v1-run/evidence/issue-18`。r1 保留编译 KeyId 拼写错误及 USD 浮点严格等值测试首败；修复是使用公开 pageUp/pageDown、以 1e-12 精度验证数值，未四舍五入原始账本。r6 的 40x12 合成导航检查发现进入新详情继承旧滚动位置，修复为视图切换重置局部阅读位置；旧 FAIL 日志保留。

r2：history + 既有 query/TUI 受影响套件 22/22 PASS。r4：seam/pre-start/半开时间窗/脱敏/TUI 定点 5/5 PASS。r5：usage 分类/原文/过滤/trace/脱敏 6/6 PASS。最终窄窗修复检查和安装绑定见 handoff.json；已通过的未受后续修改影响检查复用，没有为收尾重跑全量。

真实本机 shell、真实 Pi runtime + 明确离线 transport 的失败示范保存在 `demo-r2`：run `f86d223c-3c4a-42fa-84d8-c950dd4f3c6f`，shell exit 7，产品结果 failed，usage unknown。128 KiB 加失败标记的已取得输出逐页重建 hash 一致，慢消费者每次 3 条引用/16 KiB 原文，无积压队列；原文只读前后 host.sqlite 字节相同。固定源 `e1:31:11b4790ab7076d6955a8fbf0696f508bb5c715540a2858bfe2ef5ec5b98a93ee`，固定事实 `e1:48:6aedcb269bdeb1304435f5f020b64b2ff74f5e0e36c0f998f8e477af066efcdd`。重复查询、固定和显式导出无新请求。原 tmp 与外部副本逐文件 hash 一致，复制的是已关闭的静止数据树。

#31 测量线索：r2 全示范 130.562291291 秒，固定 11,840 个对象、88,828,283 字节；含完整安装依赖的逐文件 hash/fsync/目录同步、查询、子进程 CLI 和验证，不是单独精确 fixation latency，也不是性能通过结论。机器 MacBookPro18,1 / arm64 / 34,359,738,368 bytes RAM，macOS 27.2 (26B5101f)，Node v26.8.2，锁定 Pi 1.1.0 与已授权 TUI derivative。无预先批准阈值，此数据不证明轻量接受。#31 可据实测再选择优化，而不能删依赖或弱化可靠保存制造更好结果。

没有付费 provider 调用。合成 Terminal 只验证协议和交互接线；本票复用既有布局/宽度/退出机制，不新增独立原生 Ctrl+C/Ctrl+X 门槛。最终集成的历史内容与 #17 队列同屏仍交给 #31 的真实 Terminal 核对。操作卡是最终集成抽查材料，不是要求用户提前重跑 native matrix。未 push、merge、关票或发布。

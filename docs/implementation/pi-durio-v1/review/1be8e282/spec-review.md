# pi-durio v1 独立 Spec review

结论：**CHANGES_REQUESTED**。固定候选发现 **2 项 P1**。所有判断仅针对 `1be8e2826fa5d523e9224677838dd97b2d4d8ac3` / tree `e5ad9f25f84ded025fe7b2dff49fc08936a89eb3`；不覆盖后续修复。

- Baseline：`25d311616136766b37c0274f3f490ec1105f9592`。
- 固定 checkout：`/Users/nineofour/pi-durio-v1-run/worktrees/issue-26`，HEAD `ccc8e53257cb4274889b1a0bc3fd982fe6de3597`，tree 与候选相同，检查时 clean。
- 差异：342 files changed, 43099 insertions(+)；binary diff SHA256 `de1a6e6a0875cbb75aecf9cc2b663463fb04030c5756e28f11f37bba28a5a288`。
- 请求 reviewer 为 `gpt-6-astra` / `xhigh`；实际 backend 无独立证明。

## Findings

### SPEC-01 [P1] 普通任务预检一次性解码全部历史原文，违反内存有界合同

定位：`src/preflight.ts:116-116`。

> `docs/specs/pi-durio-v1-spec.md:69`：内存、显示及送模有界，长输出分块持久化、背压和引用分页。
> `docs/design/runtime-evidence-and-retention.md:41`：内存、显示窗口和送模上下文仍须有界；它们与磁盘原文保留是不同维度。

**触发：** 已有任意规模的历史 tool.output 等 host facts 后，启动下一次普通任务；runtime.ts:417 无条件调用 preflight。
**实际行为与影响：** SELECT 所有 records 后 .all().map 读取并 JSON.parse 每个 body，使所有 acquired.bytes/base64 原文同时驻留到预检结束，即使这些记录不是授权或恢复判断所需。显示分页、生产时分块写盘均不能限制此路径的历史总内存。 正常保留历史会线性抬高后续启动峰值，足够历史可在接受下一任务前使进程 OOM。硬约束是内存不随完整历史无界增长；本报告未发明生产 RSS/heap 数值门槛。

**证据：** [复现脚本](/Users/nineofour/pi-durio-v1-run/review/1be8e282/preflight-memory/repro.mjs)；[结果](/Users/nineofour/pi-durio-v1-run/review/1be8e282/preflight-memory/results.json)。

1536 个 16 KiB 输出块（24 MiB 原始输出、约32 MiB base64）在 `--max-old-space-size=48` 下使 preflight heapUsed 5,787,768 → 43,843,160 bytes，RSS 51,396,608 → 146,194,432 bytes；相同数据逐条读控制 RSS 63,062,016 bytes。随后独立的 24 MiB heap 检查中当前路径 SIGABRT / heap out of memory，控制正常退出。[低 heap 首次结果](/Users/nineofour/pi-durio-v1-run/review/1be8e282/preflight-memory/low-heap-24-first.json)。[producer/source-build identity](/Users/nineofour/pi-durio-v1-run/review/1be8e282/preflight-memory/identity.json) 已核验 387 项内容。

**限制：** 纯 Evidence seam；保留真实 tool.output acquired/base64 结构，但无 durable sessions、模型、完整长会话。证明全 body 驻留的失效机制，不声称产品日用性能接受。48 MiB heap 首次通过保留；24 MiB heap 是后续独立受限失效检查。

**建议修复：** 预检只流式读取恢复/授权所需事实并按 run/session 保留有界摘要，避免 materialize 历史输出。对 inspectSession 同样检查 tasks/submissions/entries 的累计和 runtime.ts:477 的再序列化，保留全 Harness 核对及只读语义；后两条为同一路径修复范围提示，未单独计为已复现发现。

### SPEC-02 [P1] 真实批次入口未将可捕获退出信号接入受控取消

定位：`scripts/live-batch/run.mjs:33-34`。

> `docs/specs/pi-durio-v1-spec.md:51`：退出停止接收新工作，请求取消并等待受管执行清理、存储关闭后再释放所有权，保留可恢复工作；
> `docs/design/eval-and-improvement.md:79`：超时/取消停止放行并终止受管执行。
> `docs/implementation/pi-durio-v1/issue-30/README.md:55`：node scripts/live-batch/run.mjs FROZEN_MANIFEST EXPLICIT_HUMAN_GRANT

**触发：** 将来用户明确授权并按已交付命令运行真实批次时，在 eval 或 improve 等待中按 Ctrl+C，或向该 host 发送 SIGTERM。
**实际行为与影响：** 入口只创建 deadline AbortController，未注册 SIGINT/SIGTERM。默认 Node 信号处理直接终止 host；signal 不会 abort，runEval/analyzeImprove 的受管取消和 finally 不会被 await，batch-result.json 也不会落盘。普通 src/eval/cli.ts:21-22 已有信号适配，但该入口直接调用 API，绕过该适配。 可捕获退出被降为硬中断；停止 provider 传输和受管 VM/进程、记录取消或 cleanup unknown 的路径没有机会完成。隔离清理的 stop/inspect/delete 位于 scripts/isolation/boundary.mjs:184-199 的 finally；停止 host 不构成 VM/外部副作用已停止的证明。

**证据：** [复现脚本](/Users/nineofour/pi-durio-v1-run/review/1be8e282/live-batch-signal/repro.mjs)；[结果](/Users/nineofour/pi-durio-v1-run/review/1be8e282/live-batch-signal/results.json)。

原控制流只替换 common import；两个合成进程分别进入 mock runEval 后接收 SIGINT 和 SIGTERM。两种监听计数均 0，均直接按对应信号退出，传入 signal 未触发 abort，最终结果未保存。

**限制：** 保留原入口控制流，仅把 common.mjs import 替换为完全离线 mock，绕过授权/工件验证以到达等待阶段；纯合成 grant/key 字符串，不构成真实付费授权，provider requests=0、VM starts=0。没有运行真实批次，也没有证明实际 VM 残留；这不是对尚未取得的 #30 实际执行验收判 FAIL。

**建议修复：** 为该入口接入 SIGINT/SIGTERM（及项目适用的 SIGHUP）到同一 AbortController，停止后续阶段，await 在途受管清理，并在 finally 保留结果/unknown 与移除监听；重复信号不得绕过清理或扩权。

## 已知 gate 与已批准例外

- #30 仍为准备状态：无真实付费授权/凭据来源，实际 provider 请求 0。未来真实任务表现未验收；SPEC-02 是已交付入口代码缺陷。
- #31 的最终本地测量与新增原生 Terminal 组合由 root 执行。本 reviewer 不把已声明未完成 gate 当隐藏完成声明。
- #32 用户日用接受未取得，不能用静态/合成/技术检查代替。
- 认可 #16 已授权字宽 patch 和 #26 可信 build 资源参数例外，不将其报为 scope creep。

## 覆盖、验证与限制

已按 Spec 轴阅读规格和设计合同，审查 runtime/授权/所有权/恢复、原文与存储、TUI 接口、eval 隔离/预算/评分、improve 精确选择/构建/启用/回退，以及指标归属与反馈路径。发现要求、定位、触发、证据和限制的结构化全表在 [spec-review.json](/Users/nineofour/pi-durio-v1-run/review/1be8e282/spec-review.json)。

本次新检查仅包含固定树身份/现有构建387项输入输出hash核验、历史输出内存定点复现和纯离线信号接线复现。现有 #29、#26 等证据用于交叉核对，没有重跑 full suite、build、VM、付费模型或原生 Terminal；#25 早期缺 dirty-source 身份的196/196不充当最终 full-suite。没有修改产品/测试，也未 commit/push。

这是固定候选的风险与行为审查，不是每行代码的正确性证明，也不是日用或真实模型验收。完整历史原文、首次结果和 OOM 遗留 owner marker 均留在外部 review fixture；未重写首败。未建立另外的 scope-creep 发现。

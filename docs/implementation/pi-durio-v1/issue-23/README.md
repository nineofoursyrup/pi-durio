# #23：显式受限 improve 分析与候选报告

本票实现规格 I1–I3、E10、T4/T5 的分析/报告部分。普通 coding 不触发分析；候选默认全部未选择。选择、建议抑制、构造候选、验证和写回/启用分别留给 #24–#26。受控 provider 演示只证明执行机制，真实模型生成候选及完整闭环留在 #30；原生 Terminal 组合和用户日用接受留在 #31/#32。

## 入口

包导出 `pi-durio` 的 `analyzeImprove({workspace,dataRoot,targetRunId,mode,request,...})` 使用同一公开 Pi `Harness`/loop。`pi-durio/improve` 导出请求校验、只读 `listImproveReports` / `readImproveReport` / `formatImproveReport` 和显式 `offlineImproveTransport`。没有后台 critic 或第二调度器。

```sh
pi-durio improve analyze --spec /absolute/improve-request.json --data-root /absolute/data
pi-durio improve list --data-root /absolute/data
pi-durio improve report --id diagnose-1 --format text --data-root /absolute/data
```

请求文件中的 `mode` 必须显式提供。`live` 使用已有 `DEEPSEEK_API_KEY` 配置和 provider；`offline` 还需显式 `--offline-demo`，仅生成受控零候选报告。不会从 live 失败退回 offline。

```json
{
  "workspace": "/absolute/project",
  "targetRunId": "existing-run-id",
  "mode": "live",
  "request": {
    "id": "diagnose-1",
    "purpose": "检查已完成任务与明确登记源码中的维护问题",
    "limits": {
      "maxRequests": 4,
      "maxTokens": 4195328,
      "maxRequestTokens": 1048832,
      "maxDurationMs": 60000,
      "maxOutputTokens": 256
    },
    "sources": [{"id":"project","kind":"project","paths":["src/helper.ts"]}]
  }
}
```

该示例只展示有效结构，不授权付费运行。请求上限最多 64、时间最多一小时、输出最多 8192 tokens；live 单次保留上界至少为 provider context 上界 `1048576 + maxOutputTokens`。这是保守的可执行门槛，非实际 token/费用预测；更短输出可能产生不完整报告。所有真实请求、失败、未知用量沿用 `PersistentBudget` 和 provider dispatch gate，unknown 阻断后续请求。超时实际取消在途工作。报告保留原 limits、预算快照和 incomplete 原因，同一 ID 不重置预算。

TUI `/improve JSON` 接受相同 `request`。裸 `/improve` 显示缺少的设置且不调用模型。忙时通过既有 management queue 绑定原 workspace/session/task/run，在 coding 完成后独立启动；steer 仍只进入原 coding。中止/退出/失败后的请求冻结，普通下一条输入不会接入。`/improves [ID]` 与 headless 读取同一报告；只读查看、按键和自然语言不构成选择。`/queue` 显示未开始、冻结、撤回；同 ID 的 report 查询也显示这些状态。

## 实际能力与证据

分析只注册三个公开 Pi tools：`evidence_summary`、`evidence_read`、`source_view`。没有 `read/write/edit/bash` 或 `ExecutionEnv`，不会导入完整 coding 对话。宿主在启动时固定 evidence cutoff、原目标、查询上限和相关文件内容。必须先读摘要，后续 evidence ID 只能来自本次有限摘要或同项目历史报告；source path 必须显式登记。默认当前 run，默认 40 条引用；显式可扩至同项目同类型的最近 10 runs、200 条引用、各 32 KiB evidence/source 外发视图，历史报告最多 10 条。每片最多 8 KiB；没有向量检索或目录搜索。

历史原文和源文件的完整取得内容保留在本地原始证据中；模型只取得有来源/范围/遮蔽原因的派生视图。凭据样、指令样和不能安全解码内容保守遮蔽；检测不是通用秘密识别器，可能整段遮蔽普通源码。清理/归档/缺失如实显示，不向别处寻找替代材料。报告重开提供当前 evidence availability，原报告 revision 不改写。

source kinds 为 `project`、`agent-config`、`prompt-skill`、`self-source`、`eval-asset`。`project` 必须是原工作区；其他类型只读显式 root/path。普通相对文件拒绝路径穿越、符号链接、`.git` 和 `node_modules`，单文件至多 256 KiB，总取得至多 1 MiB；model 仍受更小外发限额约束。此边界是分析工具能力，不宣称能隔离恶意同用户外部进程。

`self-source` 必须提供显式 root。构建脚本先取得源码/测试/脚本/锁/配置/vendor 输入与实际 TypeScript 编译器字节身份，再清理生成目录并编译，完成后确认输入未变才写 `dist/execution/source-build.json`；清单只含相对路径和内容身份、无时间戳。核对要求登记 checkout 的输入、实际 compiler 和 build 输出对应安装包中的清单与输出。package 名称、remote 或同名目录均不构成核对。缺失/不符只保留 gap，无源码视图；不会搜索目录或修改安装包。统一 execution artifact 同时保留/核验此清单。

## 报告合同与后续接口

宿主保存 `improve.started/source/summary/derived/report` 到已有 Evidence。报告有稳定请求 ID、完整内容 revision、分析 run、原目标、cutoff/deadline、预算、覆盖缺失和明确 selected=[]。最多五候选，零候选正常；无效 JSON、缺 schema、超量/未取得引用、越界 scope 或不足合同产生 incomplete，原模型输出与 attempts 仍保留。

每个候选拥有 stable ID/revision、报告内显示号、目标及内容 baseline、facts/citations、hypotheses、successCounterexamples/gaps、当前机制检查、最小 steps/scope、validation/budget/protections、risks/rollback、writeback/enable 条件时机及 stable dependencies/conflicts。宿主验证结构、引用/范围与必要条件，语义真假仍是模型分析和后续验证责任。missing identity/usable source 明确 suggestionOnly。eval 资产有独立 target/candidate；模型指令要求与 runtime 分开，不能把同时修改评分当成有效证据。

后续 #24–#26 应绑定本报告/candidate revision、target baseline 和声明计划保存决定、验证和执行；此票没有接收候选执行授权的入口。previousReports 提供同项目过去报告的稳定来源，摘要查询预留 `improve.decision` 事实；建议抑制的持久决定与匹配仍由 #24 实现。

## 验证与限制

`test/improve.test.ts` 覆盖真实公开 loop 的零候选/幂等只读、受限工具与注入、原目标队列/中止、请求/token/unknown/time 限制、固定 source 与 self-content-build 核对、缺 limits/无效候选/清理状态，以及冷进程 CLI 与 TUI viewer。`test/tui.test.ts` 覆盖实际 `/improve` 命令接入、裸命令不调模、报告查看和历史视图拒绝发起分析。

`scripts/demo-improve.mjs INSTALL_ROOT NEW_EVIDENCE_ROOT REGISTERED_SOURCE_ROOT` 从独立安装包的公开 exports 和冷 CLI 执行 useful/zero、write/shell/cross-scope/指令样证据阻断、busy queue/UI 目标切换/冻结/撤回、全部预算中断、source 对应与 mismatch、CLI 显式分析，以及完整 dataRoot 只读前后哈希一致。它使用受控 transport，不证明模型推理质量、真实性能收益或 paid/native acceptance。

最终 candidate、检查日志、首次失败、修复关联、source/build/package/install 内容身份和安装演示原件见外部 `evidence/issue-23/handoff.json`。所有远程 issue、main、release 和真实 paid acceptance 不在本票收尾范围。

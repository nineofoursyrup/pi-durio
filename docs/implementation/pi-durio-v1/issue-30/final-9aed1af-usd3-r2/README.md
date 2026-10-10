# #30 USD 3 派生批次 r2

状态：**PREPARED / AFFECTED OFFLINE CHECKS PASS / INDEPENDENT SCOPED REVIEW PASS / PAID NOT RUN**。r2 修复独立审查发现的 `USD3-SPEC-01`，产品候选保持 `9aed1af6ee3b156bb7354961496217aa5e64843e`，未改产品源码、build、package、安装或依赖。

当前外部清单：`/Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af-usd3-r2/frozen-manifest.json`，SHA256 **`51ff05f19a55cd14653f1f00dc7a07d4bc5f9931b7107091ad5207ce0e269486`**。本目录是字节相同的审阅副本。旧 USD 5 批次和初版 USD 3 `f0ccad…` 均保留；初版独立审查结论为 **BLOCKED**，不能使用初版启动。

## 唯一修复与预算

初版在安装验证前检查授权时限。独立离线 probe 证明：首次检查在到期前 1ms 通过，安装验证后到了到期后 1ms，仍可能写入 `paid-start` 并进入 eval。原失败证据位于 `/Users/nineofour/pi-durio-v1-run/review/usd3/expiry-probe-result.json`，没有被改写。

r2 在安装、runtime、fixture 和 improve request 验证后取得实际 `startedAt`，再次核对同一个原 `grantedAt` 的 24 小时窗口；过期即 `GRANT_EXPIRED_BEFORE_START`，在 runner 的凭据环境查询、`paid-start` 或计划物化前停止。不会刷新授权时间。`const output` 开始的取消、认证停止、计划物化、重试/预算、清理与结果主体逐字节不变。

预算仍为 aggregate **40 requests / 2,400,000 tokens / USD 3**，eval **32 / 1,200,000**，improve **8 / 1,200,000**。每请求 reservation **1,052,672 / 1,056,768**、输出 **4096 / 8192**、最高公开单价 **USD 1.20/M**、保守估算 **USD 2.88** 全部不变。四个 trial、grader、fixture、真实 synthetic seed、一次启动、60 分钟总期限和停止边界均不扩大。

原用户授权文字、来源和 `2026-10-10T05:34:25.010886Z` 时点仍固定，最后允许启动时点按毫秒解析为 `2026-10-11T05:34:25.010Z`。主协调者另存的凭据就绪确认不更新这个时点。新 manifest/grant 严格绑定准确文件和窗口，拒绝旧 USD 5 grant、扩大阶段/窗口/price、重复启动及扩大 proposal。

[revision-delta.json](revision-delta.json) 保留精确代码 diff、原失败与原审查 hash，以及不变文件的逐项身份。r2 相对初版只移动独立输出/数据根/价目记录引用，增加启动时限复核和对应离线 probe；使用原 logical batch ID，表示同一原授权的版本修正，不能获得第二份预算。原 `prepare.mjs` 不动、不运行；新数据根仍从原关闭数据根 APFS clone，所有原 seed/journal/fixture 字节保持。

## 离线证据与执行边界

[start-window-check-r1.json](start-window-check-r1.json) 的两个新检查均通过：

- 安装核对跨到期后 1ms：无 credential lookup、无 paid-start、无 authorized-plan、无 prepareEval/runEval。
- 刚好在原到期时点：仍可创建内存夹具计划，deadline 严格为实际 startedAt 加 60 分钟。

检查使用精确冻结的 runner/preflight 源码，只有 JavaScript `node:vm` 模块沙箱内的时间、installed API 和输出存储为夹具；没有启动 restricted VM，也没有读取实际凭据或执行 provider。

[checks.json](checks.json) 明确复用初版 **24 项入口/授权/wrapper 检查和 12 项凭据解析检查**，没有把它们改标成新跑的结果。`preflight.mjs`、`common.mjs`、`launch.py` 和这两份原检查脚本逐字节不变；新两个 probe 覆盖实际变动与有效启动路径。原 cancellation/auth-stop 证据继续按原适用范围复用。没有重跑 build、全量产品测试、VM 或资源测量。

凭据 wrapper 仍只接受固定 `/Users/nineofour/Durio/api.env`，先通过冻结授权门再打开文件，检查 regular file/no symlink/current owner/`0600`，只解析单条赋值，不执行 shell，不记录值、长度、hash 或含值异常。然后 `exec` 替换到 runner，再次检查冻结门并执行新增实际启动窗口检查。完整 installation/runtime 核对由 runner 在计划物化前执行。

未来仅由协调者运行：

```sh
/usr/bin/python3 /Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af-usd3-r2/harness/launch.py
```

本轮只生成 `paidApproved:false` 的模板，没有 `explicit-human-grant.json`、真实 `paid-start.json` 或 `authorized-plan.json`。协调者须先完成独立定向复核、确认真实 native/resource 工作已结束、核对另存的凭据就绪确认和原时限，才创建绑定本 manifest 的具体 grant，并启动一次。真实 improve 候选、revision、baseline、检查与写回范围仍需单独返回用户选择。

公开价格由原冻结官方 HTTP 200 HTML 支撑；这是文档观察，不是服务端模型认证、账户实付或账户硬消费上限。#30 真实闭环仍未完成。本分支已 fast-forward 合入 `21de8f1027cac7a004ef542ea04f98d5020df48c`，仅新增本票两个 docs 目录。提交后仍由协调者安排 merger 串行集成，不自行 push。

独立 [review](independent-review.json) 的 Standards / Spec 均为 PASS，`USD3-SPEC-01` 仅在本 r2 解决。审查 SHA256 `bf9300a5060ae9cdb23a633cdc3c9a0c25725c75bcac0e793ae3811cf201f2da`；原 f0 BLOCKED 结论保持。

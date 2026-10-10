# #11：首个 headless 只读任务与持久记录

范围：`PI-DURIO-V1-TICKETS-r1:T01`。这是首版的一条纵向路径，不是首版完成。实现直接使用公开 `@earendil-works/pi-durable` Harness/SQLite/tools/ExecutionEnv 和 `@earendil-works/pi-ai` DeepSeek provider；三项 Pi 直接依赖精确为 `1.1.0`，传递解析由 canonical `package-lock.json` 固定。

## 可运行入口与共用接口

源码安装、启动及查看命令见根目录 README。`npm run check` 执行 strict TypeScript build 和 Node 行为测试。`npm pack` 生成当前 macOS arm64 的可独立安装候选：npm 原生 `bundleDependencies` 保留生产依赖，`dist/execution/package-lock.json` 保留锁的实际内容。`scripts/prepare-pack.mjs` 仅将 esbuild 的优化硬链接变为同字节独立文件，避免 npm 解包丢弃 Link entry；不修改上游代码、版本或执行循环。

公开产品函数从 `pi-durio` 导出：

- `runReadTask({workspace, dataRoot, input, mode, transport?, signal?, cancellation?, onObservation?})` 是受控运行入口。它返回 run/session/已受理任务身份、结果、已确认清理、原始 usage 投影及完整性。`mode: 'offline'` 必须提供 transport，`mode: 'live'` 拒绝 transport override；两者不能静默互换。
- `readRun(dataRoot, runId, {after?, limit?})` 为只读、最多 200 条一页的查询，不暴露 Harness，也不打开可写 storage。`readObject` 按受限内容引用核对 hash/长度后读取持久对象。
- `signal` 配合 `cancellation: 'stop' | 'exit'`：stop 先记录中止意图，走公开 `Conversation.abort()`；exit 先记录退出意图，走 `Harness.close()`。都停止新请求、取消正在接收的 provider 流，并等待 runtime 退出。取消等待不会被当作取消工作。远端是否已终止没有证据时保持 unknown。
- `fault` 是同步的存储/初始化故障注入边界；测试不替换 Harness、SQLite 或工具执行。`onObservation` 是同步派生通知，异常只将 observation 标为 degraded。

下游 #13 可扩展 `src/read-environment.ts` 的实际执行能力边界，以及 `src/runtime.ts` 的公开工具包装；本票只有 read，没有 write/edit/bash，没有 workspace 写入者能力，也没有任意执行环境注入。工具实际 attempt 通过 AsyncLocalStorage 与 acquired bytes 关联，即使同一轮出现多个调用也不按时间顺序猜归属。generation hook 提供 durable task ID，model intent 带该 ID。后续 UI 不应取得裸 Harness。

## 记录及执行保证

1. 规范化数据根在项目外；建目录前解析现有祖先，拒绝项目内数据根时也不修改项目，包含 symlink 路径。成熟 `proper-lockfile` heartbeat 分别保护数据根和 session；第二写入者在任何可写库打开前被拒绝。锁不会仅凭 PID 或超时自动夺取。`owner.json` 提供持有者和时间；不承诺挡住同用户其他软件。
2. 在源库没有活动连接、当前数据根 owner 仍持有时，预检复制静止 main 与现存 WAL，流式 hash 核对源和副本。只有临时副本进入公开 `openNodeSqliteStorage`；分页扫描全部 task/submission/usage，不调用 Harness。旧 pending、未确认关闭、原文丢失、无授权身份的 storage 或跨库缺口会阻断新任务。没有“继续旧任务”的入口。
3. 宿主 `host.sqlite` 使用 DELETE journal / FULL synchronous；`show` 用 `readOnly: true`，且先以普通只读文件操作检查 SQLite header。未知/WAL 宿主格式不会在读取时迁移。原 durable 库与宿主库的文件集合、内容及 mtime 在只读查看/预检前后有实际比较；正常查询不创建 sidecar。源文件复制只适用于上述静止、持锁条件，不是活跃数据库备份 API。
4. 用户输入、授权、执行工件与配置、submission intent、model intent/payload 和 tool intent 均先保存再放行。原文为 fsync 后引用的内容寻址对象，宿主事实追加而不改旧结果。跨库并不原子，未确认间隙保持 unknown；掉电零丢失及外部 exactly-once 不在保证范围。
5. 每次请求保留有序 Pi messages、provider `onPayload`、实际 fetch JSON body、解析后的 provider stream events 与取得的 normalized response。记录取得边界；没有认证 headers、不可见服务端内容或 HTTP 逐字节承诺。provider 实际返回 model/response ID/fingerprint 保留在取得的消息/事件中。认证错误进入 host 与 durable 前都移除实际密钥值，避免只脱敏显示而数据库仍留存。
6. Read 工具仍是上游实现；ExecutionEnv 只开放声明项目内的读取，拒绝 write/shell，并保留实际 BinaryReader byte ranges、工具参数/结果和错误。当前路径输入 32 KiB、文件 256 KiB、最多 8 个请求；上游 read 的模型窗口仍有 50 KiB/2000 行限制，记录清楚“实际取得的范围”，不宣称未读取的整个项目都已归档。
7. 原文/必要事实写入失败会立即关闭新模型/工具放行、取消在途请求并受控关闭；已取得而未能保存的内容标为 unknown，不能靠重跑补造。持久化不了关闭收据时仍返回 unknown，下一次因缺收据阻断。仅派生通知故障不改变原结果。Harness 初始化抛错时，已分配 storage 也由 finally 关闭，清理不确定时不释放 owner。
8. usage 取自关闭后公开 storage 读取的 `pi.usage` document，按 session/conversation/document 身份保存一次范围投影，不逐 run 重加累计值。provider 未报告 usage 时 API 返回 `value: null`；部分请求已知时显示 partial 与已知部分。SDK 的零占位保留在原始 durable snapshot，但不被显示为未知请求的已知零。费用是 Pi catalog 的 USD 估算；offline 数据不是账单。
9. 执行版本实际保留自身编译 JS/declarations/maps、package manifest、lock、已安装 Pi manifests、指令/模型配置和可取得的相关 Git HEAD/status/diff。Git 读取关闭可选锁、fsmonitor/外部 diff，子进程不继承 API key。没有取得的 untracked 内容、远端权重及全部项目快照明确不可复现；npm integrity 指向相应依赖工件，当前分发包额外包含生产依赖实际内容。

## 验证索引

完整日志、独立安装、持久 demo 数据及各候选 tgz 位于 `/Users/nineofour/pi-durio-v1-run/evidence/issue-11/`。本目录 `validation.json` 保存候选与结果摘要，`first-failures.md` 保留首次失败及修复链。

| 验收要求 | 已取得证据 |
| --- | --- |
| 精确安装、公开 API、build | `npm-ci.log`、registry 元数据、严格 build、生产依赖树对比、npm pack 与独立安装；真实 Harness/上游 read，无私有 demo import |
| provider/参数与认证 | 官方 DeepSeek provider 解析与实际 provider JSON body；可控 SSE 驱动两次请求/read；缺认证退出 78，401 不 fallback，数据库无测试认证值 |
| 原文/身份/usage | 请求组成、返回字段、tool attempt/byte range、执行工件与配置；已知 usage 20 input / 8 output / 28 total；重开不新增调用；取消后 partial 已知 input=10 |
| owner/旧 pending/只读 | 第二进程经 symlink 数据根仍被挡；exit/原文失败后的未知阻断；只读重开和源库预检文件 hash/mtime/名称不变 |
| 生命周期与故障 | storage 初始化失败清理；provider 在途 stop/exit 等待；原文失败停止新工具/请求；派生观测失败只降级；未知 usage 不为零 |
| 独立演示 | tarball 独立生产安装后 bin run/show、缺认证；独立 failure demo 保存原文失败与第二写入者结果，全部为 offline |

最终 strict build 与 12 个行为测试全部通过，覆盖本票相应失败方式；没有用夹具冒充真实 provider 验收。共享代码最后变动后的检查与打包身份见 validation.json，源码纯文档更新不重新声称执行通过。

## 未覆盖责任

真实 DeepSeek 调用、真实认证有效性、实际计费、macOS Terminal/TUI、可写 coding、workspace 写 owner、跨进程恢复执行/核对决策、compaction/长会话、大文件输出、eval、improve 和首版整体验收均未在 #11 完成。没有付费调用授权，相关真实 provider 结果为 NOT RUN。旧 pending 只会安全阻断，解除或迁移交给后续恢复票；不把阻断当作完整恢复已实现。

上游 API 标记 Experimental，当前候选支持目标 macOS arm64；打包的原生依赖不承诺跨平台。参考一手入口：[Pi npm 1.1.0](https://registry.npmjs.org/@earendil-works/pi-durable/1.1.0)、[DeepSeek 官方 API](https://api-docs.deepseek.com/)、[SQLite WAL 只读限制](https://www.sqlite.org/wal.html#read_only_databases)、[npm lockfile 说明](https://docs.npmjs.com/files/package-lock.json/)。

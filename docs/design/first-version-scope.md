# pi-durio 首版范围与轻量目标

状态：2026-10-09 第一轮范围决策已收敛，[resolution 已记录](https://github.com/nineofoursyrup/pi-durio/issues/2#issuecomment-6066794453)，决策票已读回为 CLOSED / COMPLETED；不代表产品已实现或通过真实运行验收。

对应决策票：[首版范围与轻量目标](https://github.com/nineofoursyrup/pi-durio/issues/2)。远程 resolution comment 是该决策的 canonical record，本文是本地配套文档。[本票读回记录](first-version-scope-readback.json)保留 #2 关闭时的状态与 frontier；后续[上游复用与执行恢复边界](https://github.com/nineofoursyrup/pi-durio/issues/3#issuecomment-6067523440)也已完成，当前下一张为 [#4「TUI 的最小交互合同」](https://github.com/nineofoursyrup/pi-durio/issues/4)，见[最新收尾读回](upstream-execution-recovery-readback.json)。

## 已确定的要求

- 产品名为 pi-durio，基于 pi-durable，参考官方 durable coding-agent demo 与 Grok Build 的 TUI 体验。
- 尽量减少自有代码和体积，同时具备 evals、LLM Ops、tracing 和长期运行记录，以评估自身表现。
- 内置显式调用的 improve：先给有证据的可选建议，仅执行用户选中项声明的范围与必要验证。
- 本地图以可交给实现 Agent 的首版规格为终点。规划阶段不运行付费模型、不实现产品、不提交或推送代码。
- 上述能力是一条首版完整路径。实施阶段的先后顺序不等于允许删减用户明确要求。

## 沿用的推荐起点

来自原 HTML 规格第 2、3、18、20、22 章：TypeScript + Node、pi-tui、本地 SQLite、单进程与一个活动工作区写入者，TUI/headless/eval 共用 runtime；观测默认本地，先做最小查询和报告。

不因本次访谈重新选择这些可逆默认值。若首版支持范围、上游事实或实测结果与之冲突，再有针对性调整。当前没有已批准的 LOC、MB、毫秒、RSS 或费用硬阈值。

## 已确认的首版边界

| 决策 | 结论 | 依据 |
| --- | --- | --- |
| 使用与交付范围 | 先覆盖用户本机 macOS arm64 的本地日用，采用 Node CLI。首版不承担 Windows/Linux 或面向其他用户的广泛安装兼容承诺。 | 用户答复“Q1……按建议”。 |
| 初始模型 | DeepSeek V4.1 Flash；官方 API 当前模型标识为 `deepseek-flash`。模型保留配置能力，首版仅承诺这一实际使用路径。 | 用户答复“Q2先使用deepseek，模型是ds4.1 flash”；API 标识由官方文档核对。 |
| 轻量取舍 | 正确性、可追溯与用户控制是底线；优先减少自有代码和长期维护负担，再依据实际瓶颈优化体积、启动与内存。暂不设未经测量的数值门槛，不提前维护上游 fork。 | 用户答复“……3按建议”。 |

接入起点沿用此前推荐的单服务 API Key 方式，默认直连 DeepSeek 官方 API。用户明确选择的是服务与模型；官方端点/API Key 是本次在该推荐路线下采用的可逆接入默认值，不能写成用户已经逐项确认凭据存储、协议、思考配置或预算。首版不默认引入订阅 OAuth、多账号或模型路由；若后续提供实际网关约束，则在接线票调整配置。

首版完整使用路径包括本地 coding 与必要检查、TUI/headless、退出/恢复、用量与关键 trace 查询、手动 eval、长期记录查询，以及显式 improve 的建议、选择、执行验证和结果留存。具体行为由后续决策票收敛，不能把内部实施阶段当作删减这些目标的理由。

当前机器只读观察：macOS/Darwin arm64，Node v26.8.2。该事实只说明开发环境，不自动代表用户要求的支持平台或最低 Node 版本。

## 轻量测量与验收方向

先建立可运行基线，再按同一口径比较改动；本票不发明数值预算。至少分别记录：

- 自有维护代码的范围、源码行数与模块/依赖边界；明确测试、生成文件、vendored 代码和依赖是否计入，不能通过换统计口径伪装精简。
- lockfile 对应的生产安装体积与实际分发体积，分别注明是否包含 Node、原生组件和开发依赖。
- 相同机器/终端下的冷启动、空闲 RSS 和代表性长会话峰值；将本地程序开销与网络/模型耗时分开。
- 代表性工作量下的记录增长、写盘/查询开销和大输出行为。
- coding、eval、improve 各自的已知模型用量、耗时和费用口径；不把优化分析/验证本身的成本藏起来。

接受减体积或减调用的候选，前提是所需行为与验证仍成立。没有实际数据时只记录目标或待测项，不声称产品轻量达标或性能已经改善。

## DeepSeek 公开文档核对

核对日期：2026-10-09（Asia/Shanghai）。[官方更新日志](https://api-docs.deepseek.com/zh-cn/updates/)说明 V4.1 Flash 使用 `deepseek-flash`；旧的 V4 Flash 名称只是临时兼容路由，本项目不以旧别名作为初始配置。

[官方首次调用文档](https://api-docs.deepseek.com/en/)提供 `https://api.deepseek.com` 与 API Key 接入方式；[Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)列出 `deepseek-flash`、stream 与工具调用接口。上述均为公开文档核对，未访问账户、读取凭据或调用真实模型。

Pi 固定快照的[模型生成器](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/ai/scripts/generate-models.ts#L2984)已定义 `deepseek-flash` / DeepSeek V4.1 Flash，走 `openai-completions`；[内置 provider](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/ai/src/providers/deepseek.ts)使用官方端点和 `DEEPSEEK_API_KEY`。无需因本次模型选择预先新增 provider 适配器；安装产物、真实鉴权与工具轮转仍待实现基线验证。生成器也注明静态费用 schema 尚不能表达分时低谷价，因此后续数据合同不能把它的成本估算当成实际账单。

`deepseek-flash` 是 API 标识，不是不可变的模型权重版本证明。后续运行记录需区分请求模型、返回标识和可获得的后端指纹；实际协议、参数、流式工具调用与用量适配由“上游复用与执行恢复边界”和“运行证据与长期记录合同”承接。模型自身具备额外能力不自动扩展本票的首版产品范围。

## 已有事实与边界

- [上游核对](../research/pi-upstream-audit-2026-10-09.md)：durable 已提供核心 loop、storage、恢复和 usage；薄宿主仍有间接依赖。少量自有代码不等于安装体积小，按 provider 子路径导入不自动裁剪 npm 依赖。
- [TUI 与 improve 参考核对](../research/tui-improve-audit-2026-10-09.md)：借鉴 Grok 体验不等于必须移植 Rust TUI；retro 参考本身仅提出建议，长期记录与选择后执行需要 pi-durio 宿主落实。
- 上述为静态源码核对，未取得产品安装体积、冷启动、RSS、模型调用或性能改善基线。

## 留给后续决策票

本票确定首版支持范围与接入形态；具体认证存储、公共 API、工具与恢复机制由“上游复用与执行恢复边界”决定。TUI 交互、数据拓扑/保留、eval 方法与预算、improve 的目标权限和版本生效分别由对应票解决。

原 HTML 保持不变。本票的阶段性平台范围、模型起点和测量优先级均可调整，尚无必要创建独立 ADR；不把普通默认值包装成难以逆转的架构决定。

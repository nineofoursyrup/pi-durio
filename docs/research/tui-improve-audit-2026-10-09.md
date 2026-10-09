# pi-durio：TUI 与 improve 参考核对

核对日期：2026-10-09（Asia/Shanghai）。这是 Wayfinder 建图前的只读事实核对，不是已确认设计或实现报告。先读本地规格第 22 章，再读第 7、12–15 章；本报告按用户最新要求统一称内置功能为 `improve`，`retro` 仅指外部参考。未安装、构建或运行参考项目；未运行测试或写入 GitHub。

## 固定版本

| 参考 | 本次核对版本 |
| --- | --- |
| Grok Build | [`2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8)；`xai-grok-pager` manifest 版本 `1.0.45` |
| Grok 原 monorepo revision | [`SOURCE_REV`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/SOURCE_REV) 记录 `559751fdcec02d413e4c57c8832ab275e4f44980`，与公开仓库 SHA 分开记录 |
| Matt Pocock skills | [`b0618bc436ad893b3c5e84e55fba86586d34a404`](https://github.com/mattpocock/skills/tree/b0618bc436ad893b3c5e84e55fba86586d34a404)，读取 `skills/engineering/retro/SKILL.md` 与根目录 `LICENSE` |

## 已核实事实

### Grok TUI

- 公开源码是 Rust CLI/TUI 与 agent runtime。TUI 位于 `xai-grok-pager`，shell/runtime、tools、workspace 分属其他 crate；支持交互、headless 和 ACP。[README](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/README.md)
- TUI 使用 Ratatui、Crossterm、Tokio，自有 textarea/渲染组件；workspace 声明 Ratatui `0.29`、Crossterm `0.28`。Manifest 还包括语音、Mermaid、插件、工作区等能力，不能把整个 Grok TUI 视为可直接嵌入 TypeScript 宿主的轻依赖。[pager Cargo.toml](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/Cargo.toml)、[workspace Cargo.toml](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/Cargo.toml)
- 交互文档有全屏 scrollback、块折叠/展开、全文查看、prompt 与 scrollback 焦点切换、键盘与鼠标导航，以及随焦点/运行状态改变的快捷键提示。输入区区分发送和运行中排队；`Esc` 与 `Ctrl+C` 有不同语义。上述是文档合同，本次未进行真机体验验证。[Keyboard Shortcuts](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/03-keyboard-shortcuts.md)
- 状态行可显示模型、上下文、用量等；无法取得的字段省略，缺失费用不能解释为零。事件更新有防抖，脚本输出有大小限制。这些是可借鉴的数据展示边界，不要求 pi-durio 实现自定义状态行脚本。[Status Line](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/25-status-line.md)
- README 声明第一方代码为 Apache-2.0，第三方与 vendored 内容保留各自许可；若后续复制代码，应按实际文件核对 notice，不能统一当作第一方代码。[License section](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/README.md#license)

### retro 的真实边界

- Frontmatter 为 `name: retro`、`disable-model-invocation: true`。正文从用户请求复盘出发，读取指定会话的一手材料，未指定则当前会话；寻找导航、自动检查、规则、工具开销、无效指令和信息访问问题，最终按严重程度呈现候选。[固定 SKILL.md](https://github.com/mattpocock/skills/blob/b0618bc436ad893b3c5e84e55fba86586d34a404/skills/engineering/retro/SKILL.md)
- 它要求使用 `writing-for-agents`，包含实现/评审分工的假设，并将没有 pre-commit/CI guardrail 本身视为发现。它没有定义长期记录 schema、用户选项身份与版本、选择后执行流程、权限系统或效果验证协议；正文终点是建议。以上是对该文件内容与缺项的核对，不是对某个宿主实现的推测。[同一 SKILL.md](https://github.com/mattpocock/skills/blob/b0618bc436ad893b3c5e84e55fba86586d34a404/skills/engineering/retro/SKILL.md)
- 根目录是 MIT License（2026 Matt Pocock）：复制或实质改编再分发时应保留版权与许可声明。[LICENSE](https://github.com/mattpocock/skills/blob/b0618bc436ad893b3c5e84e55fba86586d34a404/LICENSE)

## 建议与设计推论（尚待决策）

1. **TUI 借鉴体验，优先验证 pi-tui 能否覆盖最小交互。** 首轮聚焦会话、输入、简洁状态、工具输出展开与 improve 候选选择。中文宽字符、长输出、缩放、取消和异常退出后的终端恢复应纳入原型检查。是否承诺全屏与完整鼠标操作，需结合实现成本与基线测量决定；本次不能证明 pi-tui 与 Grok 体验等价。
2. **借鉴 retro 的证据方法，内置一个独立的 improve 流程。** 保留显式调用、一手证据、先查现有机制；外部技能依赖、固定第二 reviewer、缺 guardrail 自动成为改进项都不直接继承。允许零候选或证据不足，避免为了复盘而增加代码与规则。
3. **权限和用户选择由宿主执行。** `disable-model-invocation` 只有宿主识别并落实才有触发效果；Markdown 不构成工具隔离。建议阶段只暴露范围受限的证据读取能力，报告可写到宿主自身记录；项目、配置与 runtime 修改能力仅在选择后开放。选择绑定候选版本、目标、基线、动作与生效范围，未选项不执行。来源为[本地规格第 12–15 章](../../pi-durable-coding-agent-spec.html#s12)与用户最新要求；这是需实现和验证的产品合同，不能记为参考 skill 已提供的能力。
4. **效果结论独立于执行成功。** 保存证据、选择、变更和验证引用；选中或检查通过并不等于长期性能提升。先做有边界的候选验证，后续再用版本可比较的真实运行结果确认收益；仅验证选项不自动启用改变。来源：[本地规格第 13–14 章](../../pi-durable-coding-agent-spec.html#s13)。

## 最多三个关键未决问题

1. 首版 TUI 的最低体验合同：全屏、鼠标、折叠与状态显示各有哪些必需项，以及需覆盖哪些终端？
2. improve 首版允许修改哪些目标，如何定位 agent 自身源码，以及选择“仅验证”和“修改并启用”的具体生效边界？
3. 长期建议所需的最小证据、保留期限与候选效果判定如何取舍，才能兼顾轻量与可追溯？

本地目录当前没有 Git 元数据，无法给本报告绑定工作树 commit；报告之外未修改其他文件。以上问题供建图使用，本次未代替用户作出决定。

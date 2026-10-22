# #92 Terminal / golden / 截图准备

这是 redesign 的 PREP 工具。当前交付只验证离线脚本；真实 Terminal.app、中文 IME、字形、鼠标、截图和用户首次确认全部 `NOT_RUN`。这些状态与 #93 付费路径、#94 A2 受控测量、日用接受分别记录。脚本不读取 `api.env`，不启动 VM，不调用付费模型。

## 固定候选与只读核验

未来验收开始前，使用最终干净源码和实际安装包创建**新**目录。先按项目流程完成该候选的 build / 安装；此脚本不负责构建或安装。下面的绝对路径占位符应替换成实际值，`PREP` 的父目录必须已存在。

```sh
SOURCE='/absolute/path/to/clean-final-candidate'
PACKAGE='/absolute/path/to/frozen-installed-package'
PREP='/absolute/path/to/new-terminal-prep'
node "$SOURCE/scripts/redesign-terminal/prepare.mjs" --source "$SOURCE" --package "$PACKAGE" --out "$PREP"
node "$PREP/harness/verify.mjs" --manifest "$PREP/manifest.json"
node "$PREP/harness/native.mjs" --manifest "$PREP/manifest.json" --verify-only
```

`prepare.mjs` 核对 `dist/execution/source-build.json` 的**完整**源码输入、编译器文件及产出集合与当前文件一致，拒绝 tracked dirty、未跟踪 build 输入、额外/缺失/变更产物。它固定 Git commit/tree、source-build SHA256、安装目录完整清单、复制到 PREP 的 harness 清单及 Node/platform/arch。外部文件 symlink、指向候选内部的输出路径（含 symlink 和 `..prep` 边界）被拒绝。`--synthetic` 只用于小输入测试，不能用于 native 或正式 golden 生成。

manifest schema 为 `pi-durio-redesign-terminal-v1`；跨票接口为 `candidate.{commit,tree}`、`source.{root,sourceBuildSha256}`、`installation.{root,files}`、`harness.{root,files}`、`runtime.{node,platform,arch}`、`synthetic`。`files` 每项为 `{path,sha256}`，内部 symlink 的值为 `link:<target>`。安装/harness 的新增、删除和内容变化都会使 verify 失败。`verify.mjs --manifest` 和 `native.mjs --verify-only` 在产品导入、凭据访问、fixture、子进程和终端活动之前返回。它们只证明固定文件仍相同，不证明 native 验收。

每次操作必须使用复制后的 `$PREP/harness`。所有输出默认拒绝覆盖已存在目录；失败的半成品和首败记录也保留。重试使用新的编号目录，并在外部记录前次路径、原因及变更。不能把开发 SHA 当作未来集成验收身份，也不能改写旧 fixture、旧 golden 或原接受记录。

## 离线九屏

```sh
node "$PREP/harness/goldens.mjs" --manifest "$PREP/manifest.json" --output "$PREP/grids-01"
# 只有已有相应基线时才比较；缺失不会自动变为 MATCH。
node "$PREP/harness/goldens.mjs" --manifest "$PREP/manifest.json" --output "$PREP/grids-02" --baseline "$PREP/grids-01"
```

开发时可用 `goldens.mjs --development --package /absolute/path/to/worktree --output /absolute/path/to/new-grids`。这种产物的 `candidate`/`manifestSha256` 为 null、`developmentOnly=true`，不能冒充冻结候选。

生成 37 份带颜色 token / 样式列区间的 UTF-8 字符网格：九屏各有 132×38、80×24、40×12；1b、1e 在 132×38 补 256 色和无色；1e 同时包含六例 oracle、零分母和未知状态。宽字符的 continuation cell 不重复打印字形，列号按公开 `visibleWidth` 与 grapheme 分割；共用 SGR 的 token 会以 `|` 并列。该列宽不是 native CPR。2c 仅对布局比较，示意数字用 `#`，不作性能测量。

输入来自本目录 `fixtures.mjs` 的明确合成事实：只新建小 SQLite/objects fixture；合成时钟固定，不是采集的宿主时间。1a 包含上下横线输入框、状态及提示行，不沿用旧 33 行 welcome golden；1c 依照当前 `ReadOnlyTui.recoveryPlan` 保留头部/状态并依次收起；1d/1e/2a/2b/2c 使用产品 renderer 和 `ReadOnlyTui.openPanel` 共用的 `showFullScreen` compositor，覆盖完整 terminal 的宽高，短内容也用空格补满视图，三档均沿用终端自身背景；局部用户块、选中、斑马以及模态框/菜单自身面板背景保留，弹层下底层去掉全部局部底色并使用 `fg.gutter`。这些是当前产品构帧；既有 PREP 与其网格保持原件，新候选需生成新输出。1f 直接调用 `exitSummary`，没有 `bg.base`；网格剩余行仅为原缓冲区空位。

`golden-index.json` 分开记录 `generated=GENERATED`、`regression=NOT_RUN|MATCH|DIFFERENT|MISSING`、`userConfirmation.status=NOT_RUN`。一致只证明相同夹具重复渲染，没有用户接受含义。首次请用户逐屏对照设计快照：`docs/specs/pi-durio-redesign-spec.md` 的 U1–U14；设计 HTML 固定 SHA256 为 `3aa504953f46bec54012b380cdbbea6800fb9f4a1818f4b746b920f208eb2dec`。每屏将具体差异修正，或由用户明确接受偏离，并保存用户原话、时间和本份 grid 的 SHA256。不得自动把 `MATCH` 填成确认。

## 未来用户运行：机器观察

本节命令需在实际 macOS arm64 Terminal.app 中由用户启动；当前 PREP 不运行。窗口先设 132 列、38 行，`TERM_PROGRAM=Apple_Terminal` 必须由真实环境提供，不能手工伪造。三个新进程分别检查启动时档位：

```sh
env -u NO_COLOR COLORTERM=truecolor node "$PREP/harness/native.mjs" --manifest "$PREP/manifest.json" --tier truecolor --output "$PREP/native-truecolor-01"
env -u NO_COLOR COLORTERM= node "$PREP/harness/native.mjs" --manifest "$PREP/manifest.json" --tier 256color --output "$PREP/native-256color-01"
env NO_COLOR=1 COLORTERM=truecolor node "$PREP/harness/native.mjs" --manifest "$PREP/manifest.json" --tier none --output "$PREP/native-none-01"
```

程序用实际 `ReadOnlyTui`、真实 `ProcessTerminal` 和宽度门，运行于新 fixture 项目及数据根。transport 只持续产生合成文本、遇中止退出；没有远端请求或工具调用。机器会保存环境、每个实际输入键码、settled 前后画面/队列、resize、ANSI 输出、`stty -g` 与 raw mode 前后、退出结果和宽度观察。输入与输出只用于本次证据，因此输入公开的测试文字即可。

每档按以下顺序操作，不需按得很快：

1. 等字宽校准结束。空输入按 `?`，等待帮助出现；`Esc` 返回。输入 `probe`，单独按 `?`，确认仍是文本 `probe?`。每步等待至少 150ms，使前后观察完整。清空这段文本。
2. 先按 Ctrl+G 标记 PgUp 尝试开始，实际按 PgUp（Mac 通常 Fn+↑），再按 Ctrl+G 确认已尝试。PgDn 同样用 Ctrl+N → PgDn（通常 Fn+↓）→ Ctrl+N。这四个标记键仅供 harness 记录，不交给产品。闭合尝试收到对应键码记 PASS，已尝试但没收到记 FAIL；未尝试或标记未闭合保持 NOT_RUN。首个失败不会被随后成功覆盖。
3. 提交 `中文输出测试`，等待合成流开始。输入 `follow one` 后 `Ctrl+X`、Enter，再同样排队 `follow two`；等待两项都显示待接入。输入保持空，在距上次 Backspace 至少 500ms 后按第一次 Backspace，再间隔约 200–400ms 按第二次。首个可判定键对用于结果；需看到只撤回最新一项，第二次没有撤回余下项。太快而无法取得前后观察的键对为 `NOT_RUN`，不能补猜 PASS。
4. 将窗口依次改为 80×24、40×12，再回到 132×38。保留所有 resize；缺任一尺寸则该尺寸保持 `NOT_RUN`。
5. `Ctrl+C` 停止合成任务，等待停止完成；在空闲状态按两次 Ctrl+C 退出，或使用 `/exit`（有草稿时按界面确认）。程序等待产品清理并把实际退出摘要写入原缓冲区。检查光标、输入与背景是否恢复。

机器状态只有 `PASS`、`FAIL`、`NOT_RUN`。颜色检查包括复合 SGR 与 basic color，宽度必须有实际 CPR 观察；raw 必须观察到运行时进入 raw 并恢复初始值。`modes` 只证明最后输出的 cursor/mouse/paste/alternate-buffer 序列，视觉恢复仍需人工。`FAIL` 不被同次后续成功覆盖。捕获不到的、未做的、观察被相邻按键打断的项目保留 `NOT_RUN`。

## 人工逐项记录

原始 `operator-checklist.json` 保持不动。将它复制到新的接受记录目录，逐项填写 `status: PASS|FAIL|NOT_RUN`、实际观察、时间、用户原话和证据路径；机器 checklist 另存，不互相代替。

| 项目 | 最小操作与记录 |
| --- | --- |
| 中文 IME | 欢迎输入与持续输出期间分别组合中文；候选 Enter 只选字，不提交；候选窗跟随真实硬件光标。记录输入法/版本、字体/字号与失败位置。 |
| 字形/颜色 | 对照固定设计稿的 48 字形；包括 `✓ ✗ ◈ ⋯ ┃ ▏ + −` 和 10 帧 braille spinner，复制中文、组合字符、emoji。三档都检查字形仍在，1e 核对覆盖条与成功/警告/失败值配色。 |
| 歧义宽度关闭 | Terminal 设置中关闭“东亚歧义字符为宽字符”，Ctrl+L 重测，核对列对齐、光标、复制与鼠标。记录 setting 和本次 widthCalibration。 |
| 歧义宽度开启 | 开启同一 setting，再 Ctrl+L；允许字形变为 2 列，布局/光标/鼠标应跟随。若宽度门未确认则记 FAIL/NOT_RUN，不能以离线宽度代替。 |
| 鼠标 | 实际主会话滚动与选文、点工具行展开、点击欢迎历史入口、队列“撤回”命中且只作用该行。合成文本交互没有工具行时，工具行项目保持 NOT_RUN，待 #93 相同候选的真实路径有工具行后补观察。静态 gallery 不提供命中验证。 |
| `/stats` 页签 | 在顶层用 Tab/Shift+Tab 切“指标/本机实测”；进入子层再按，不应切顶层。子层需有可进入记录，无记录时该项 NOT_RUN。 |
| 2c 样本 | 在实际交互进程 `/stats --self` 观察按键样本累积，按 `b` 后累计值不清空。gallery 的零样本是示意，不是该项证据，更不是 A2。 |
| 退出恢复 | 正常退出与实际可捕获故障分别记录。查看光标、raw 输入、鼠标/粘贴、原缓冲区及终端自身背景；本 PREP 未注入 native 故障，未做故障路径则仍 NOT_RUN。 |

## 13 张截图

用同一冻结 manifest 的 gallery 显示实际产品 renderer 的合成固定输入。它只提供截图画面：除 Esc/Ctrl+C 退出和 Ctrl+L 重测外不派发动作。窗口必须 132×38。

```sh
env -u NO_COLOR COLORTERM=truecolor node "$PREP/harness/native.mjs" --manifest "$PREP/manifest.json" --tier truecolor --screen 1a --output "$PREP/gallery-1a-truecolor-01"
```

等待实际宽度校准和稳定画面后，用 macOS 截图快捷键手工保存 PNG；再按 Esc 结束 gallery，以保存 `gallery.json`。1f 是原缓冲区的真正有界 `exitSummary`，直接返回，不把摘要重画成全屏背景；可先在 Terminal 新窗口留出清楚的原缓冲区，再启动 1f。不得录屏。

逐一将 `--screen` 替换为 `1a 1b 1c 1d 1e 1f 2a 2b 2c`，真彩各一张；1b、1e 各补两张，分别使用前述 `COLORTERM=`/`--tier 256color` 和 `NO_COLOR=1`/`--tier none`。一共 13 个槽位，清单在 `$PREP/screenshots.json`。

```sh
node "$PREP/harness/capture.mjs" --manifest "$PREP/manifest.json" --run "$PREP/gallery-1a-truecolor-01" --image '/absolute/path/to/user-screenshot.png' --output "$PREP/attachment-1a-truecolor-01"
```

attach 核对相同 candidate/manifest、Apple_Terminal TTY、132×38、screen/tier 和 PNG，保留图片 SHA256、原 gallery 的宽度/失败事实及执行版本 `{sourceBuildSha256,node,installationManifestSha256}`。2c 的 `environment.build` 是 source-build digest，不能换成 Git SHA。attach 状态只能是 `ATTACHED_NOT_VISUALLY_CONFIRMED`；画面是否属于该版本、格数与内容是否正确仍由用户确认。照片不齐、来源不明或 width 未确认时如实保留缺口。

把人工清单、九屏首次确认和 13 个附件路径汇总到新的接受记录；记录本次 manifest SHA256，保留首败与后续编号尝试。最终 tracker 更新需另按票据流程和授权执行；本 PREP 不更新票面、不关闭 #92。

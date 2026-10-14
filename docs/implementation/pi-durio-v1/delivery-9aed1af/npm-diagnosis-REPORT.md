# 9aed1af 分发包依赖诊断

候选：`9aed1af6ee3b156bb7354961496217aa5e64843e`。环境：macOS arm64，Node `v26.8.2`，npm `11.19.1`。本报告仅覆盖依赖内容、安装和 npm 判定边界，不代表全套技术验收或日用接受。

## 结论与建议

在当前规格要求的 macOS arm64 实际分发包安装、运行入口范围内，**未发现必须修改产品内容才能交付的缺陷**。精确候选 archive 在全新离线 consumer 中首次安装及重复安装均成功，CLI `--help` 和 12 个公开 import 均通过，授权的 `pi-tui` 派生依赖完整且一致。

存在两项已独立复现的 npm `11.19.1` 限制，必须保留失败结果：

1. `npm ls --omit=dev --all --json` 为 **FAIL / ELSPROBLEMS**：bundled `file:` 依赖没有独立来源元数据，被 npm 判为 invalid。该诊断不能据此报告依赖内容有误，也不能将 npm 命令改记为 PASS。
2. tarball consumer 的 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund --offline` 为 **FAIL / EUSAGE**：npm 自己生成的 consumer lock 缺少包内未安装的其他平台 optional 依赖；`ci` 要求它们出现在 lock 中。本候选在上述工具版本和离线 consumer 场景下不支持该重建路径。此限制不应泛化为所有 npm 版本、在线路径或源码仓库 `npm ci` 都失败。

建议本轮保持候选及授权派生工件不变，以内容身份、首次/重复安装与运行入口的实际证据完成对应的安装检查；将上述两个原始 FAIL 作为独立工具兼容性限制写入交付记录。该建议不改变当前规格、不把失败变绿，也不代替负责人判断其余技术验收。

## A. bundled file 依赖的 npm ls 判定

原失败：`../final-candidate-9aed1af/install-first-failure.json` 与 `../final-candidate-9aed1af/installed-dependencies.log`。在原安装上以独立日志/cache 目录只读复现，同样 exit `1`；输出为 `original-installed-npm-ls.json` / `.stderr`。

实际内容核对：

- 原派生 tarball、候选 archive 中 `vendor` 的派生 tarball、原安装中的派生 tarball SHA-256 均为 `90a1f855d1e5f30d9b97c8733ca0a1c3a05ce07d5e95af4e2fed6f553e34f62a`。
- 原派生 tarball、候选 archive 的 bundled `@earendil-works/pi-tui`、原安装 `pi-tui`：**202 个文件一一对应，内容 SHA-256、大小、权限 mode 全部一致，没有 missing/extra/mismatch**。
- 包内 upstream SHA-256 为 `5d0f9dfb31c06f27d1fb2b05d166fc0d33430f53ece0a3ff3f69d55950f1430b`，与授权 manifest 一致；未切回官方版本、未扩大派生补丁。
- 文件级清单见 `content-check.json`；重跑脚本 `content-check.py` 只读产品。

根因：安装后的 bundled `pi-tui` 在主 lock 和 hidden lock 中 `inBundle:true`，但 `resolved` / `integrity` 为空，package 也无 legacy `_requested`。npm Arborist `edge.satisfiedBy()` 即使目标在 bundle 中仍调用 `depValid()`；其 `tarballValid()` 仅通过 `resolved` 字符串或 legacy `_requested.saveSpec` 判定文件来源，两者都没有时返回 false。它没有比较已安装文件与 tarball。

此外，`fromPath()` 把局部 `file:vendor/...tgz` 相对路径基于外层候选 tarball 的所在目录解析，而非已安装 package 目录。因此原安装中的确存在完整 `vendor` 文件，但 npm 推导的 `pack/vendor/...tgz` 路径不存在。当前 false 判定先由缺失 `resolved` 触发；简单复制来源工作区 lock 的相对路径也不是可靠修复。

只读 `arborist-probe.cjs` 记录在 `arborist-probe.json`：原 `depValid` 为 false；仅在独立内存 plain stand-in 中加入期望 `resolved` 字符串会成为 true，即使该路径不存在。这是判定机制的反证探针，**不是产品修复或真实安装通过证据**。没有改原安装节点或锁。

独立两包最小复现 `minimal-repro/`：parent 在源码目录的 install / npm ls 均 exit `0`；pack 后 consumer 的 install / repeat install / npm ci / 每次 require 均 exit `0`，只有前后 npm ls exit `1`，同为 bundled local-file invalid。小包没有 pi-durio、pi-tui、派生 API、native helper、网络或 registry 依赖。

## B. consumer npm ci 的独立失败

真实候选独立验证位于 `actual-product-reinstall/`，首次 cache 为空，使用原候选 archive 的绝对 `file:` 引用。全部 install 使用 `--omit=dev --ignore-scripts --no-audit --no-fund --offline`，不访问 registry、不运行安装脚本。

| 步骤 | 结果 |
| --- | --- |
| 第一次 `npm install` | exit 0 |
| 第一次 CLI help / 12 public imports | 全通过 |
| 第一次 `npm ls` | exit 1，同 A 的唯一 invalid |
| 重复 `npm install` | exit 0 |
| 重复安装后 CLI help / 12 imports | 全通过 |
| 重复安装后 `npm ls` | exit 1，同 A |
| `npm ci` | exit 1 / EUSAGE，25 个非本机平台 `@esbuild/*` 缺 lock 项 |
| `npm ci` 失败后 CLI help / 12 imports | 全通过 |

首次、重复安装、ci 失败后的 consumer lock **逐字节一致**，`pi-tui` 202 文件也完全一致。`ci.js` 在校验 lock 后才执行删除 `node_modules`；本次失败在删除前发生，没有破坏已经可用的安装。命令逐条结果、stdout/stderr 与阶段 lock 都保存；新首败 `03-clean-ci.stderr` 不覆盖、不修补。

`ci-probe.json` 使用与 npm ci 相同的 `loadVirtual`、`buildIdealTree`、`validateLockfile` 逻辑，只在内存检查。它确认 25 项全部满足：

- optional 依赖；
- 位于 bundled subtree；
- 当前 macOS arm64 不适用的其他平台包；
- 在源码仓库完整 `package-lock.json` 中已有正确版本及平台元数据。

安装 bundled archive 时没有独立抓取这些未打包的可选包，生成的 consumer lock 只有实际 bundle 的内容。npm ci 重新构建 ideal tree 时尝试补齐声明中的缺席 optional 节点；空 cache / offline 下出现版本为空的占位节点。`validate-lockfile.js` 遍历 ideal inventory，对任何缺少的节点报错，不排除 optional、非本机平台或 bundle 项。这就是实际 EUSAGE 的直接原因。

该问题独立于 A：

- `minimal-optional-repro/` 只用精确版本声明 bundled leaf，完全没有内部 `file:` 必选依赖。可选包缺席时 install=0、ls=0、ci=1。
- `minimal-platform-optional-repro/` 进一步提供真实、可读的本地 foreign tarball，包明确声明 `os:["!darwin"]`。因此不依赖 registry 缺缓存或不存在版本。仍为 install=0、ls=0、ci=1，报 `Missing: diagnosis-foreign-platform@1.0.0 from lock file`。
- 同一平台 fixture 的 `--omit=optional` 对照仍 ci=1；因此不建议宣称该开关是已验证解决方案。

## 源码 npm ci 与 consumer npm ci 的区别

仓库 README 中的 `npm ci` 是源码开发安装，使用 checked-in 完整 root lock。调度方已有该路径通过的证据；本诊断没有重跑，也未改写其结果。源码 root lock 中存在上述 25 项已由本轮只读核验确认。

用户把候选 tarball 作为依赖装入另一目录时，npm 生成的是另一个 consumer lock；源码 root lock 不作为该 consumer 的 canonical lock 使用。包中的 `dist/execution/package-lock.json` 是执行身份记录，npm 不会把它当 consumer 安装锁。因此消费分发包的 ci 首败不能倒推源码 ci 失败。

## 可操作方案与修复成本

- **当前推荐**：保留 `file:` archive 的源码安装身份和已授权派生版本；直接用固定候选 archive 在新目录 `npm install --omit=dev --ignore-scripts --no-audit --no-fund --offline`。首次与重复安装都已有真实 PASS。记录当前 consumer 离线 ci 未支持及 npm ls 误判限制，保留两条 FAIL。
- **若必须支持 consumer ci**：需要新的打包候选与验证任务。可以研究发行包自带可被当前 npm 版本识别的完整锁（例如 npm 11 的 `npm-shrinkwrap.json`），保留 non-host optional 元数据而不打包其他平台二进制；必须验证 file 依赖路径重定位、bundle lock 合并、精确派生 provenance 和冷 cache consumer ci。该方案本轮**未验证**，不能作为现成修复；它会改变 archive、manifest、候选 identity，须重做受影响装包与独立审查。
- **不建议为让 ls 变绿改版本声明**：单把分发 manifest 中 `file:` 改成派生 semver 会使 npm 用版本而非本地 archive 来源判定，但改变了依赖来源声明，且不会解决 optional lock 的 ci 失败。它不能替代当前精确工件身份，也不值得仅为消除工具告警加入候选。
- **不得采用**：改原安装 lock / `_requested`、删除 optional 声明、打包所有平台、静默切回官方 pi-tui、改 npm 本机源码或把失败结果涂成 PASS。本轮均未这样做。

## 证据保全与探针边界

所有写入限定此新诊断目录；原 repo、source、dist、Git、产品 state、PR、原安装与原失败文件未修改。`original-input-identity.json` 与 `original-input-unchanged.json` 核对原始 manifest/locks/失败日志，全部 unchanged。没有建立修复 worktree、提交或调用真实 provider / VM / Terminal。

一次诊断探针初稿误用 Arborist `Inventory.has(key)`（此类接收 node），导致它的“missing 项列表”过宽；实际 npm validationErrors 仍是 25 项。初稿及原结果已保留为 `ci-probe-inventory-api-error.*`，不作为产品证据。修正为 `inventory.get(key)` 后 `ci-probe.json` 与 npm 原始 25 项失败严格一致。该探针自身错误没有改产品或掩盖首败。

运行脚本均拒绝覆盖其首次 fixture 目录。`product-reinstall.mjs` 在 ci 首败按预期立即停止，随后只读身份核对和 help/import 检查另存。所有 npm 安装/测试探查已结束；资源窗口已释放。

主要外部依据（判定仍由本机固定版本源码和复现实验支撑）：

- [npm v11.19.1 dep-valid.js](https://github.com/npm/cli/blob/v11.19.1/workspaces/arborist/lib/dep-valid.js)
- [npm v11.19.1 edge.js](https://github.com/npm/cli/blob/v11.19.1/workspaces/arborist/lib/edge.js)
- [npm v11.19.1 ci.js](https://github.com/npm/cli/blob/v11.19.1/lib/commands/ci.js)
- [npm v11.19.1 validate-lockfile.js](https://github.com/npm/cli/blob/v11.19.1/lib/utils/validate-lockfile.js)
- [npm v11 bundleDependencies / optionalDependencies 文档](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)

相近的 npm [#9821](https://github.com/npm/cli/issues/9821) 报告也有 bundled install 成功但 ci 要求缺锁项的现象；它的具体依赖版本冲突与本案不同，因此仅为背景，不作为本案归因依据。

# 首版 runtime 记录夹具

来源：f26ae8f4b8039608a1fa796e1c69da4d8173d112，冻结安装清单逐文件核验。所有记录由首版公开 runtime 入口写出，transport 为离线合成输入。真实 provider、原生 Terminal、日用接受均 NOT_RUN。

重建使用仓库内的便携冻结清单 `scripts/fixtures/v1-frozen-build.json`，不再要求本机历史 `candidate-identity.json`。该清单只固定候选、source-build、全部安装文件/链接内容与 Linux runtime 身份；SHA-256 为 `7cd21af10280ae331aa3b77df06588d398a2d343d6f2aed71725d39b84b05546`。本目录原归档的 `fixture-identity.json` 仍保留生成当时的 `ec96dbf…` 历史身份，不改写。

从新空目录重建（在当前仓库根目录执行）。省略第二个参数时，从冻结源码、锁定镜像和锁定 npm 依赖创建 Linux runtime，需要 macOS 的 `/opt/homebrew/bin/container` 和本机已有的锁定镜像，不需要任何本机历史 runtime 路径。容器内的 `npm ci --omit=dev` 一定访问 npm registry；宿主的 `npm ci` 在缓存缺失时也会联网。

```sh
fixture_rebuild="$(mktemp -d -t durio-v1-rebuild)"
node scripts/fixtures/prepare-v1-candidate.mjs "$fixture_rebuild/frozen"
node scripts/fixtures/generate-v1-records.mjs "$fixture_rebuild/records" "$fixture_rebuild/frozen"
node scripts/fixtures/generate-v1-readonly-denial.mjs "$fixture_rebuild/readonly-denial" "$fixture_rebuild/frozen"
shasum -a 256 "$fixture_rebuild/frozen/candidate-identity.json"
```

已有内容与权限完全相同的 Linux runtime 时，把它的绝对路径作为 `prepare-v1-candidate.mjs` 的第二个参数传入。任何内容或权限摘要不符都必须停止；不能更新冻结清单来接受不同输入。

`prepare-v1-candidate.mjs` 的完整顺序是：

1. 核对仓库便携清单 SHA。提供第二个参数时，核对输入 Linux runtime 的全部相对文件/链接内容摘要；省略时，先用 `container image inspect` 确认锁定镜像已存在。两条路径都拒绝已有输出目录。
2. `git archive f26ae8f4b8039608a1fa796e1c69da4d8173d112` 解包到新 `source/`，在该目录运行 `npm ci --ignore-scripts`、`npm run build`。依赖固定于首版 `package-lock.json`；这一步可能访问 npm，不调用模型。冻结安装保留 esbuild 的 JS 启动文件；普通 `npm ci` 的 postinstall 会把它换成原生二进制，使冻结内容摘要不匹配，因此必须使用 `--ignore-scripts`。
3. 核对 `source/dist/execution/source-build.json` 的 SHA 为 `8f4ce2a273559d871b76c1cf14971a0df048d7f86b8216ff45b3d8dd2a710821`，同时绑定源码、compiler 和输出。
4. 在 `source/` 执行 `node scripts/prepare-pack.mjs`、`npm pack --ignore-scripts --pack-destination ../pack`，再在空 `install/` 中执行 `npm install --offline --ignore-scripts --no-audit --no-fund ../pack/pi-durio-0.1.0.tgz`。
5. 核对独立安装全部 12,925 个文件/链接的有序 `{path, sha256}` 清单 SHA 为 `523e37e0ac33db2fe078fc836de8234c87f9dd79b16acf2e9d5fee2419feda37`；包压缩字节可因 npm 版本改变，但产品与依赖内容不能改变。提供第二个参数时复制 Linux runtime；省略时，在 `source/` 执行 `scripts/eval/prepare-runtime.mjs <output>/linux-prepared <frozen.image>`，将准备目录的包元数据、`vendor`、`node_modules` 与独立安装的 `dist`、交付记录中的环境元数据组合成 `linux-runtime`。两条路径都核对 Linux runtime 内容清单 SHA 和含权限的 `describeImproveRuntime` identity，通过后写下便携清单，得到可供两个生成器使用的 `FROZEN_CANDIDATE`。

Linux runtime 的派生顺序与 `docs/implementation/pi-durio-v1/delivery-f26ae8f/artifact.json`、`linux-runtime-derivation.json` 一致：首版准备脚本在锁定 Linux arm64 镜像中安装依赖，再组合同一 f26ae8f 独立安装的 `dist` 和记录中的环境元数据。准备阶段的日志、计划与 `dist/test` 留在 `linux-prepared`，不进入最终 runtime。已从新目录核对 12,891 个文件/链接内容，清单 SHA 为 `d68693b680484721424943bac65f621e288fb0881dace94e3454f9f0157d2100`；12,851 个执行内容条目及权限的 runtime identity 为 `173a8fcf34c463c7bcf2527c16c7852ead668fc9c69c26acf3d7d0d2991e1d9c`，两者都与冻结清单完全一致。

两个输出目录都必须不存在。生成过程不修改原夹具与冻结安装；独立临时项目和数据根路径见新记录。主生成器的工具结果故障使用公开 fault 接缝：真实 write 已发生、结果记录失败，经首版恢复接口显式 skip，不制造 durable 状态。`improve.decision-frozen` 是已受理但首组前取消的提交批次，与 `frozen-improve` 排队分析不同。新生成物的 UUID、时戳和耗时会改变；重建验证其来源与行为，不要求新数据根字节等于历史归档。

测试只读解包使用 `test/v1-runtime-fixture.ts`：按 `archive.json` 核对压缩字节 SHA、临时解包、核对 runtime provenance，完成后检查原数据每个文件 SHA 与文件数未变再清理临时目录。需写操作的接续/撤回测试另复制数据；不写回归档。

| Testing Decisions 行为 | 真实记录与显示验证 |
|---|---|
| 二次接续、分支显示号/编号/“分支自”、原会话链尾 | `session-chain.test.ts`、`history-view.test.ts`；`history-navigation.test.ts` 在独立数据副本验证接续与“执行版本已变” |
| 存储按原会话/分支分组 | `storage-view.test.ts` 的首版分组用例；不相关的清理与布局用例仍使用 mixed 确定性输入 |
| 导入前中止自成会话、原链尾仍可接续 | `session-chain.test.ts` |
| skip 原说明、只读续跑、时间线排除中断 | `recovery-panel.test.ts`、`trace.test.ts`、`history-view.test.ts`；`trace-132x38` 只来自主 runtime 归档 |
| 只读续跑中的拒写 | `readonly-denial.tar.gz` 是既有真实 `../v1-readonly-denial` 的纯归档副本；`v1-readonly-denial.test.ts` 与 `history-view.test.ts` 从这里解包读取 |
| improve 不进待选择、历史详情、多次决定计数、可回退、冻结批次禁继续 | `improve-history-view.test.ts`、`v1-records.test.ts` |
| 冻结 follow-up、手动压缩、improve 批次 | `queue-reattach.test.ts`、`v1-records.test.ts`；撤回/新任务在独立副本执行 |
| 非 UUID 的报告/计划/队列号、原 id 解析 | `session-chain.test.ts`、`improve-history-view.test.ts`、`eval-view.test.ts` |
| 任务类型推导与 history 筛选 | `session-chain.test.ts`、`v1-records.test.ts` |
| 首版 eval 美元预算、绝对 δ、真实 trial | `eval-view.test.ts`、`v1-records.test.ts` |

首版离线限制与未声称的覆盖：transport 提供合成模型输入，因此真实 provider、模型质量、原生 Terminal、日用接受不能由这些夹具写出或证明，均为 NOT_RUN。只读拒写能由首版写出，已由独立生成器实际产生，不能列作“首版不支持”。主归档原说明中的该项是“另有真实夹具”，不是伪造许可。主、副归档组合包含 #66 场景所需记录；没有为缺失运行事实补写 `Evidence` 或 durable 状态。

数据/工作区体积：102078478 bytes，12766 files（不含此说明和身份清单）。

| 场景身份 | 完整 ID |
|---|---|
| run.coding | 09697fe1-21dc-4c60-a92c-7da338d912b5 |
| session.coding | ae261871-9316-41a6-8131-62035e1d6425 |
| run.read | 08f3ae09-dd58-4bb9-b3b5-08296c3fb535 |
| session.read | d663e3c0-f32b-46b1-9c1f-8204a014be5a |
| run.fork-1 | 122bb9ea-6044-43c0-b4b9-793e265ae1d7 |
| session.fork-1 | b73de9e7-c190-4f48-887c-1ac5027199f4 |
| run.fork-2 | 6e6f4419-bc50-4a17-8ecd-46e5258f425c |
| session.fork-2 | 736093e9-9fcc-4d1c-b27a-d70b2a3f160f |
| run.early-abort | 51e146e9-4c6f-434a-ac86-f62ba5803195 |
| run.uncertain-source | 0c9835ba-b862-4428-882b-b7feec79b90f |
| session.uncertain | 71292f47-0eec-47e4-8f07-9aea3cbed4bc |
| recovery.snapshot-uncertain | 9d7ac08399b2580f7640889b429d86304579475db59253bb04a02613e74b7097 |
| run.recovery-skip | 0c9835ba-b862-4428-882b-b7feec79b90f |
| run.readonly-followup | 9f0e6179-a712-41d0-92ed-f60330972838 |
| run.improve | e437020e-7f4d-45d4-966e-3a0da5882c0e |
| improve.report | fixture-improve-1 |
| improve.decision-defer | improve-decision-defer-1 |
| improve.decision-validate | improve-decision-validate-1 |
| improve.decision-suppress | improve-decision-suppress-1 |
| improve.suppression | e1:346:d0d4fa9de6c4be05745ca5793b37898314e8e93471585566b5262dfac49d2965:6899d68c8f41bd83f4eef169b5d80c759f2c871642846134617226dca2af3be8 |
| improve.decision-frozen | improve-decision-frozen-1 |
| improve.decision-execute | improve-decision-execute-1 |
| run.frozen-source | b4902a61-04e6-4ce7-b20e-50967e02c27e |
| session.frozen-source | 60b18f0f-efb4-4ed5-b881-7492b77841a4 |
| eval.plan | fixture-eval-plan-1 |

缺口：
- readonly-write-denial: Provided by the separately preserved v1-readonly-denial fixture, generated through the same frozen runtime.

仓库归档：25336882 bytes，SHA-256 `63e0c24a77e8e1cff58c02021cfa80e001bbb75f7bc223d1726777d328702d52`；按 archive.json 的 parts 顺序拼接为 tar.gz。分片每份最多 4 MiB，以符合自源码核验的单文件上限。展开后数据/工作区字节与生成物一致，测试在临时目录只读验证后清理。历史混合夹具仍保留在 ../v1-records。

只读拒写副归档：1,261,261 bytes，SHA-256 `f0312d15fdf42133266d04182d0e998f926c741cddf2b79a03aa242b7516644e`。源身份清单 SHA 为 `1d48c63d06094b8208c6759ee7d6980b5b3bacd5e5516932f63bdb18337b0148`；run `96381cc1-26f9-46e6-930a-f8232fd59e1d`，session `edab0a58-199e-4a77-af0a-3138d2632e05`，decision `v1-readonly-denial`。主归档与原目录均未改写。

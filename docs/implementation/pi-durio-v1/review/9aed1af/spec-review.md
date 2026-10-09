# 9aed1af 独立 Spec 复审

**PASS（截止预算修复及相邻行为）**。新增硬缺陷 0，scope creep 0；不表示首版验收完成。

固定 candidate `9aed1af6ee3b156bb7354961496217aa5e64843e`，tree `d76896b400bb90c3beb82d847d9b43ba86fc5a07`；差异基线 `74a91eac93c19e17e82a91a9ad38c3aaea023273`。HEAD/tree、tracked clean 和四个原规划文件范围已核对。请求 `gpt-6-astra/xhigh`；实际 backend 无独立证明。

- **原截止/归因缺陷已修复。** V6（`docs/specs/pi-durio-v1-spec.md:86`）要求“开始新 trial/请求/重试/compaction 前检查额度和时限，重启不重置预算或截止点”。`boundary.mjs:89–176` 在 staging 后及实际 create/start 前检查同一 deadline/cancellation，执行 timer 不将不足 100ms 的剩余额度抬高。已有 create 的清理未知仍优先为 invalid；未 create 不声称 terminated。
- **执行与产物事实分开。** E1/I8（规格 `:68/:100`）要求保留实际取得原文和验证内容身份。`improve-validation.ts:135–158` 先留 execution/output；失败或取消缺 targets/export 失败时保留原原因与独立缺口，成功仍检查完整候选。build/startup/check、eval runtime/grader 同传绝对截止；未启动 eval 保留 budget-stopped/cancelled，剩余 trial 不启动；grader 拒绝不新增确定判断。
- **既有结论复用。** 上轮 SPEC-01 与 SPEC-02 的已修复结论保留，未改实现复用原完整审查。本轮重新检查共享取消/输出调用链，未发现相邻规格回归。

独立 hash 读回 **555** 条 source/compiler/output、**123** 个 compiled tests/fixtures、**14** 份 gate 引用和 **12** 个原首败引用无差异；已存 **11** 个 VM 的 stop/inspect/delete/absence 全部成立。复用 7 个边界负例 RED→GREEN、10 个 controller 调用链回归、实际 VM smoke/source/output/eval 证据，分组不相加。controller 结果只证明控制流。

原组合 **251 tests / 250 PASS / 1 FAIL** 原样保留。新 source 正常路径耗时 246140.77ms，600000ms 是执行前固定的新 fixture 预算，原 300000ms 首败不改写。当前 gate 为 **PASS_WITH_APPLICABLE_REUSE**，没有新全套 PASS 声明；跳过子测试的表面 PASS 和错误 fixture 断言均未采用。

仍未满足：**#30** paid DeepSeek 真实闭环；**#31** 最终 native Terminal/完整技术资源验收；**#32** 用户日用接受。#16 已授权字宽接缝例外保留。本 reviewer 未运行新行为测试、build、VM、provider、Terminal，未读 Standards 或修改产品/Git/state。

另有交付验证未决项：独立安装后 `npm ls --omit=dev --all --json` 返回 `ELSPROBLEMS`，唯一项为 bundled `file:pi-tui` invalid；[首败记录](/Users/nineofour/pi-durio-v1-run/evidence/final-candidate-9aed1af/install-first-failure.json)保留。产品归因 **UNKNOWN**，由协调者另行诊断；本轮 PASS 不覆盖该安装 gate。

[机器报告](/Users/nineofour/pi-durio-v1-run/review/9aed1af/spec-review.json) · [独立身份读回](/Users/nineofour/pi-durio-v1-run/review/9aed1af/spec-evidence-readback.json)

Spec：原两项 P1 维持已修复；本轮截止/归因缺陷已修复；未结硬发现 0。

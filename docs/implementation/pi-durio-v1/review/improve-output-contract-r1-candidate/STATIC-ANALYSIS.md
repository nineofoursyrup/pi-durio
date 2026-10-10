# 实际候选 R1 的静态核对

本记录只准备用户选择材料，没有执行候选、保护检查、产品API或正式写回。原报告及revision保持不变。

- Report：`v1-live-r4-improve`，revision `b8e9b7c7c08d06d5ed955339630fac5e1b8fe59e6e700acd6499863d932aad2a`。
- Candidate：`candidate:197afe0a113c5c58ad0810ca24a4ad98`，revision `49e9331f282cda12efe5fb89f4b6ef35b8e50a8dc2d8140fa48c5fe3824c91c8`。
- Target：`/Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af/improve-project`，baseline `46864e756634ac28260fe43119d15103008ce1a2fbc9b37b548c2b2027ab257f`。
- 原状态：unselected / not-started / unverified；activation仅声明未来writeback=true、enable=false。

## 原提案中的准确改动

仅把 clamp.ts 的内层 `Math.min(lower, value)` 改为 `Math.max(lower, value)`，保留现有TypeScript签名、文件其余字节及全部保护文件。

```diff
-export const clamp = (value: number, lower: number, upper: number) => Math.min(upper, Math.min(lower, value));
+export const clamp = (value: number, lower: number, upper: number) => Math.min(upper, Math.max(lower, value));
```

拟写字节SHA256：`45e016afe980df19159fc0679a6e44d88838a7a5afc398820309b576884f003c`。这是原candidate.steps[0]的逐字实现准备，不是新模型候选或已验证结果。

## 必须披露的推理错误

原report.summary开头自相矛盾；candidate.hypotheses[1]还错误声称原in-range和above-upper案例已通过。在已声明lower≤upper下，原表达式可直接化简为min(lower,value)，所以(6,0,10)和(14,0,10)都静态得出0。这反驳了该推断；没有运行任何表达式或check来产生新验收证据。

拟议表达式先用max保证下界、再用min保证上界，静态上符合README声明及保护检查的输入类别。该已知叙述错误不应被隐藏，也不自动证明提案执行成功；建议向用户披露后呈现精确补丁，并在明确选择后通过既有受限验证流程运行原check.mjs、核对保护字节，成功后才按选定范围写回。

本记录不能改写正式report为“事实完全正确”，也不授予选择、验证、写回、激活或回退。原raw、正式与reopened报告均保留。真实执行效果、保护检查及重开仍待后续明确授权与实际证据。

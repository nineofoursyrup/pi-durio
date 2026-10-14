# 当前真实批次授权请求

状态：**FROZEN / NOT AUTHORIZED / PAID NOT RUN**。候选 `9aed1af6ee3b156bb7354961496217aa5e64843e`。旧 prepared-r1/r2 全部保留，不再作为当前执行清单。

当前清单：`/Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af/frozen-manifest.json`，SHA256 `d5272b244660c2a54a2fc70d1f5c50785ed20edf92a3dfb78a7e24ef7dfb3a22`。完整 proposal：`/Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af/proposed-batch-reviewed.json`，SHA256 `6af625fa56de175368f5e0063b43ee13bdef095a59a3cc4c9736684001afa877`。本目录副本可审阅，执行仍读取清单绑定的原始路径。

- DeepSeek `deepseek-flash`，固定 endpoint `https://api.deepseek.com/chat/completions`。
- 4 个代表任务各 1 次：局部修复、多文件协作、回归保护、纯分析不改文件；全部成功后进行一次有真实失败来源的 improve 分析。
- 两阶段合计最多 40 请求、4,000,000 token；申请 USD 5，按已观察最高 token 单价保守估计 USD 4.80。这不是账户硬消费上限或实际账单。[官方价格](https://api-docs.deepseek.com/quick_start/pricing/) 和 [模型元数据](https://api-docs.deepseek.com/api/list-models/) 的观察限制见 `provider-recheck.json`。
- 授权后 24 小时内一次启动，启动后 60 分钟整体期限；中止、失败、未知隔离状态、认证失败或预算不足均停止后续步骤，不自动创建替代批次。
- 凭据来源仍未指定；只接受用户明确许可的本地来源，然后注入 `DEEPSEEK_API_KEY`。本次未读取密钥或认证。
- 原始 seed 在真实公开 runtime 执行固定失败检查，内容未改；它是合成来源记录，不是付费模型成功。
- 实际 improve 报告中的候选仍未生成或选择；本批授权不选择未知未来写回。取得实际候选、revision、目标基线、拟写内容、检查和回退方案后，才交用户选择并继续闭环。

新清单绑定 sourceBuild `0559e34005b6b6f981af0b09877f4a8c4d7bcb15dc05e9ce21435370145d6886` 和 Linux runtime `5957b89d214074d12353abb58bd88460cc2160e54943b8fc094896e246512d7a`，复用已验证隔离依赖。当前入口对显式 false grant 在凭据使用和计划物化前拒绝，原退出 1 记录保留；这是拒绝检查通过，不是实际调用通过。

已向用户提交本清单授权问题，尚未收到授权。#30 继续未完成；#31 完整技术验收和 #32 实际日用接受仍分别待办。

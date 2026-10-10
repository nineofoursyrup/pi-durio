# 新分析输入的一次启动授权请求

本文件是待人类决定的具体请求，不是授权记录。上一批 r2 已消费一次授权并停止：7次请求全部known、cleanup confirmed，但模型报告违反输出契约，正式incomplete / 0 candidates。原始失败与 UNKNOWN 预留保留。

- 批次：`pi-durio-v1-live-r4-improve-report`；request：`v1-live-r4-improve`。
- 冻结 manifest SHA256：`809aa5350c2d1d3cd3fac9281210ce41e2ff643e889a565bd15f25ae02e30856`。
- 固定产品：`f26ae8f4b8039608a1fa796e1c69da4d8173d112`；沿用已核对的原构建、安装、fixture及纯候选validator。
- 范围：仅启动一次 improve analysis。新输入只明确纯JSON输出、候选必填项、依据已取得证据作事实陈述、gap不伪装成候选；没有预填修复答案。分析允许零候选或最多一个有依据的项目修复候选，不承诺一定成功。
- 新上限：8次物理请求、1,200,000 charged tokens；单次请求预留上界1,056,768，输出最多8,192 tokens，分析最长5分钟。请求数与token均为硬上限，先触及者停止。
- 先前累计：41次请求、106,026 known tokens + 1,056,768 UNKNOWN reservation = 1,162,794 charged upper tokens，固定最高单价估算USD1.3953528。
- 加入本批后的累计上限：49次请求、2,362,794 charged upper tokens；按冻结价目最高USD1.2/百万token估价上界USD2.8353528，累计帽仍为USD3。不是账户账单，原raw952不回填旧账本，SDK/guest镜像不重复相加。
- 有效期：直接人类同意后24小时内唯一启动；启动后最长60分钟有效，内部分析仍最多5分钟。失败、未知结算、账本写入/读回失败、鉴权失败、取消或超时立即停止，不自动重启、补跑或扩大预算。
- 凭证：沿用已许可的 `/Users/nineofour/Durio/api.env`，只由冻结wrapper在批准后读取；不展示密钥。
- 本授权不包含 eval、候选选择、验证、激活、写回或接受。若实际生成候选，将先呈现确切report/candidate revision、允许改动和保护检查，再请求明确选择。

建议回复：**批准 output-r1 一次 improve 分析，累计不超过 USD 3**。也可回复暂不运行。

需要新的直接回复，是因为原实施请求要求逐批批准真实调用，而 r2 的单次启动已消费；本次是新的冻结输入和批次。此前批准不能转用，也不会因等待时间经过而自动启动。#30/#31/#32 的未完成状态保持不变。

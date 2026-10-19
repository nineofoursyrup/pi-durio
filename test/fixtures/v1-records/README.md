# 历史混合夹具

该目录是原 #66 渲染/读取回归的固定输入。原生成器在恢复场景手工改写 durable 状态，并直接写入 eval.trial-started；旧身份说明“All records written by the v1 build”不准确。已更正元数据，保留原数据与工作区字节。它不能证明真实恢复或 eval 执行。

原身份清单 SHA-256：`834050653c127529a3f3d11b036848da88e67af7120d5a4de447109ba769d7d0`。数据/工作区体积：6306728 bytes，652 files，不含说明与身份清单。

新的首版兼容验证使用 [真实 runtime 夹具](../v1-runtime-records/README.md)，包含公开 runtime 接口生成的恢复 skip、冻结 improve 提交批次及实际离线 eval。

# 修复候选的体积实测补充

候选 `f26ae8f4b8039608a1fa796e1c69da4d8173d112`，tree `ceebaeb3805dd8f2eeab948792f88e6f9a0ba2e0`。本轮状态为 `NEW_CANDIDATE_INVENTORY_MEASURED_TECHNICAL_ACCEPTANCE_PARTIAL`；只补测源码、包和新独立安装体积。完整清单、哈希和口径见 `measurement-summary.json` 及其 `newInventory` 引用。

| 项目 | 当前候选 | 相对旧 9aed1af |
| --- | ---: | ---: |
| 自有产品源码 | 80 文件 / 795,472 bytes / 7,531 物理行 | +2,633 bytes / +50 行 |
| 测试 | 42 文件 / 486,214 bytes / 4,640 物理行 | 独立列出 |
| 项目 scripts | 39 文件 / 286,749 bytes / 2,557 物理行 | 未变 |
| 压缩安装包 | 19,222,769 bytes | +1,531 bytes |
| 完整独立安装 | 90,158,076 logical bytes | +7,908 bytes |

安装包含依赖和 vendor，不含外部 Node；物理行包含空行和注释，不是质量分数。APFS allocated bytes 不等于唯一物理占盘。没有预先约定的数值阈值，因此这些数字不构成“轻量通过”。

新安装的 source/build/package/installed 内容一致，CLI help 和 12 个公开入口导入通过。Node/npm、package/lock、打包策略和整个依赖字节未变，原 `npm ls` 与 consumer offline `npm ci` 兼容性 FAIL 继续保留，没有重标 PASS。

旧启动、RSS、长会话、1 MiB 输出、composition 和 readonly 仍是 `9aed1af` 的实际测量，未改标为新候选实测。独立适用性评审另行记录；本轮没有新 native 工作负载、VM 或 provider 请求。

真实 coding 四类各有 PASS：首批 local-fix 加补充批次 multi-file/regression/no-change。原首批失败、unknown 和 not-run 保留；这不是同一批四例全部通过，也不是新候选重跑。两批累计 34 物理请求，host 已知 61,560 tokens，另保留 1,056,768 tokens 的 unknown 占额；固定最高单价估算的保守上界 USD 1.3419936。原 improve 响应的 952 tokens 只列为根因诊断观察，不释放原预留、不与 SDK/guest 镜像重复计数，账户账单未观察。

`#30` 真实 improve 闭环、`#31` 完整技术验收和 `#32` 用户自己的实际试用与明确日用接受仍未完成。

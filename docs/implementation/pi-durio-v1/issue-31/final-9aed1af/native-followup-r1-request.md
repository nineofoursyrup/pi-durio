# Native 首次失败的定向后续批次（未运行）

产品候选 `9aed1af6ee3b156bb7354961496217aa5e64843e` 保持不变。原批次 `MEASURED_WITH_FAILURES`、原 `IMPROVE_REPORT_NOT_FOUND` 与所有原始文件原样保留，详见 `native-report.md`。

唯一 composition 变更：在 `/improve` 的异步报告轮询中，只把 `Error.message === 'IMPROVE_REPORT_NOT_FOUND'` 当作尚未出现的报告继续等待；其他异常原样抛出。原始已归档 harness 不修改，修复副本位于 `/Users/nineofour/pi-durio-v1-run/preparation/issue-31/native-followup-r1`。

小型离线回归 **PASS**：使用实际已安装的 `readImproveReport`，从新 harness 提取实际 callback 和原有异步 `until`，在隔离的新 fixture 先读 missing，再定时持久化 started 与 complete；原 callback 确认重现 missing 失败，修复 callback 等到 complete。`EVIDENCE_CORRUPT` 与带额外后缀的 missing 字符串均原对象抛出。此回归没有启动 TUI、VM、build 或 provider，不能代替 native 重测。

后续只运行两个步骤：修复后的 `composition`，然后使用原成功 `native/long-session` 作为输入执行 `readonly-data`（30 queries + 5 full-output acquisitions）。不重复三个 idle 和 60 轮任务。新配置绑定原 config / failed result / successful long-session result、plan、大输出 hash；新输出为 `/Users/nineofour/pi-durio-v1-run/evidence/issue-31/final-9aed1af/native-followup-r1`，启动时拒绝覆盖。

待主代理复核后，由用户在系统 Terminal 启动：

```sh
/opt/homebrew/Cellar/node/26.8.2/bin/node /Users/nineofour/pi-durio-v1-run/preparation/issue-31/native-followup-r1/native-followup-batch.mjs /Users/nineofour/pi-durio-v1-run/evidence/issue-31/final-9aed1af/native-followup-r1-config.json
```

本文件仅准备；当前 `PREPARED_NOT_RUN`。后续完成也不产生真实 DeepSeek、真实 improve 人类选择或 #32 日用接受的结论。详细文件身份与离线回归引用见 `native-followup-r1-preparation.json`。

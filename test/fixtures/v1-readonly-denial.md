# 首版只读续跑拒写记录

`v1-readonly-denial/` 补足 `v1-records/` 中缺少的真实首版拒写记录；后者保持原样，其旧 `skip` 记录仍是对应处置的测试来源。

生产者是独立安装的首版候选 `f26ae8f4b8039608a1fa796e1c69da4d8173d112`，tree `ceebaeb3805dd8f2eeab948792f88e6f9a0ba2e0`。生成前后，脚本逐文件核实整个安装及其依赖与固定 `candidate-identity.json` 一致；同时核对原包和源码归档的哈希。当前构建只读取这份 fixture，不生产其中的事件。

场景通过首版 `runCodingTask` 创建 `target.txt`，在真实 `tool.result` 后中断；`checkRecovery` 识别 `completed-uncommitted`，`recoverRun` 以只读能力继续。离线 transport 请求用另一份内容覆盖同一目标，首版 runtime 写下 `recovery.capability-denied`，随后允许读取原文件。最终目标仍为 `first authorized effect\n`，原 host 记录前缀与内容对象保留，原 `run.closed` 仍为 `unknown`。这与改版“仅拦截已完成的相同调用”的规则不同。

`fixture-identity.json` 保存生产者出处、生成脚本哈希、运行环境、场景身份、恢复前记录引用、实际只读开始/拒写事实、目标文件证明及完整文件清单。记录中的绝对工作区路径属于当时运行事实，未重写。模型响应为 synthetic transport；没有网络请求、模型推理、付费调用或真实 Terminal 验收。

重现时提供原冻结工件，并指定全新的输出目录；脚本拒绝覆盖已有 fixture。生成会建立单独的临时工作区，失败记录也保留。按项目约定先检查至少 30 GiB 可用空间，并在共享 `check.lock` 内串行执行：

```sh
node scripts/fixtures/generate-v1-readonly-denial.mjs \
  /absolute/path/to/new-v1-readonly-denial \
  /Users/nineofour/pi-durio-v1-run/evidence/final-candidate-f26ae8f
```

常规回归仅需当前构建及仓库内 fixture：`node --test dist/test/v1-readonly-denial.test.js`。测试核对固定首版 runtime/recovery/source-build 身份、拒写与原记录保留，再通过当前 `readTrace` 和 `TraceView` 验证只读段、拒写说明和未记录字段；读取前后检查整份 fixture 未变。

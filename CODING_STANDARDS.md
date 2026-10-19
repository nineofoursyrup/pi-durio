# 编码标准

Standards 轴复审时逐条对照 diff，引用条目编号。能机械检查的问题由 build 和测试负责，不列在这里。

## S1 1b 显示字段统一经过 `safe`

`ReadOnlyTui` 构建工具块时（`src/tui/app.ts`），条目里每个会显示到 1b 的字段都要经过 `safe`，并登记进 `displaySources`。给 trace 条目新增显示字段时，两处一起改。

- 原因：`safe` 把控制字符换成 `�`，同一条目各字段的显示才一致；`displaySources` 用于提前测量宽度。渲染函数里的 `clean` 会直接删掉控制字符，不能替代 `safe`。
- 范围：只管 1b。历史正文层（`src/tui/history.ts`）统一用 `clean`，不适用本条。

## S2 需要分支处理的错误用子类

调用方要识别某一种错误、走不同分支时，在错误来源模块导出 `Error` 子类，调用方用 `instanceof` 判断，例如 `StatsChoicesLimitError`、`ReplacementMismatchError`。子类的 message 保持 `CODE: 说明` 格式，不设 `name`。

- 原因：按 message 前缀判断，会让同一个错误码在多个模块里各自解析。
- 例外：把错误码映射成显示文案的查表逻辑（`improveChoiceError`、`storageFailure`、`cli.ts` 提取错误码）按冒号前的错误码查表，属于正常用法。

## S3 写进报告的文案按字节冻结

候选和报告里持久化的字段会计入 revision：`src/improve.ts` 中 `revision=digest(JSON.stringify(body))`，`suggestionReason` 等文案也在 `body` 里。这类取值在来源模块定义为常量，逐字节保持不变。diff 改动了这类取值时，作为兼容性问题报告：旧报告的 revision 会对不上。

## S4 测试里的用户可见文案写字面量

测试断言用户看到的文案时，直接写字面量，不引用产品代码里的常量。这样产品常量被误改时，测试会失败。

# 首次失败与修复链

原始日志保留在 `/Users/nineofour/pi-durio-v1-run/evidence/issue-11/`，未覆盖旧记录。下列修复后的检查只证明本票声明的 offline 路径。

| 记录 | 首次观察 | 处理与后续证据 |
| --- | --- | --- |
| `red-01-build.log` | 首个行为测试先写，runtime/offline 模块不存在，build 失败 | 实现公开 Harness 纵向路径；`test-04.log` 首次通过 |
| `build-02.log` | public 类型约束识别 thinking 参数名称、工具 schema 类型及 hook 返回值不符 | 沿用实际声明的 reasoning、typed tool、undefined hook result，严格 build 通过 |
| `test-01.log`–`test-03.log` | Pi ai 未导出 package.json，CommonJS require.resolve 也不支持其 ESM root | 用 `import.meta.resolve` 定位公开 root，filesystem 读取 manifest；没有私有 API import |
| `red-02-original-failure.log` | 原文落盘故障被标成普通 failed | 原文缺口保留 unknown，取消在途、阻断新工作；`test-05.log` 通过 |
| `red-04-auth-init.log`、`test-06.log` | HTTP 401 不进入成功 onResponse；仅脱敏 stream event 后，上游 result() 仍将密钥样值写入 durable；初始化后的 storage 清理缺口 | 真实 fetch status；同时脱敏结果接口；storage 提升到 finally 所有者并关闭；`test-08.log` 相应行为通过 |
| `test-06.log`、`test-09.log`、`test-10.log` | 只读 SQLite 源连接会创建空 WAL/SHM；改为源文件快照后又暴露 /var 与 /private/var 别名误拒绝 | 宿主改 DELETE；durable 原源只通过文件读/拷贝访问，SQLite 只开静止副本；源路径 realpath；`test-12-zero-source-writes.log` 全部源文件对比通过 |
| `installed-smoke/dependency-comparison.json` | tarball 包含 shrinkwrap，但当前 npm 独立安装的两个类型依赖漂移：@types/node 24.10.1→26.6.4、undici-types 7.16.0→8.9.0；其余版本集合一致 | 保留该候选 tgz/树与实际 run/show；改用 npm bundleDependencies，不能把类型依赖漂移称为 exact |
| `bundled-smoke/install.log` | bundled esbuild 硬链接被 npm tar 解包过滤，postinstall 找不到 bin/esbuild | prepack 将硬链接转为同字节独立普通文件，仍用原生 npm pack/install；最终独立安装结果见 validation.json |
| `red-05-data-root-mutation.log` | 拒绝项目内 data root 前先 mkdir，错误配置仍产生项目目录 | mkdir 前解析现有祖先并检查项目边界，覆盖普通和 symlink 路径；`check-16-data-root.log` 全部 12 个测试通过 |

`red-03-cancellation.log` 是新增取消场景的首次运行，直接通过；名字不将实际 PASS 改写成 FAIL。`test-14.log` 的 10 个行为全部通过，`test-15-partial-usage.log` 额外验证首请求已提交、次请求在途取消后保留 known 部分与 partial；最终共享代码调整后的 `check-16-data-root.log` 对应 12 个行为全过。曾运行的错误候选不被后来的成功覆盖。

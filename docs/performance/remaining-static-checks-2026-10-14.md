# T02 静态检查修复报告

日期：2026-10-14。仓库：`/Volumes/CaseSensitive/workspace/myself/db-connect`。分支：`dd`。

## 状态

已完成指定三个文件的修复，3 项 ESLint 错误和 1 项 Clippy 复杂类型错误均消除。未执行提交、推送、真实发布命令、安装依赖或创建分支/工作树。未编辑用户未跟踪清单或共享文档。

## 修改

- `scripts/release.mjs:205、214`：分支推送及标签推送失败重新包装错误时增加 `{ cause: error }`，完整保留原中文恢复/重试提示。
- `scripts/release.node-test.mjs:4、192、356、371`：显式从 `node:url` 导入 `URL`；在原有内存测试装置中记录抛出的错误对象，两项行为断言验证包装后的 `cause` 与原错误严格相同，并验证完整中文提示。测试执行真实 `runRelease` 编排，外部命令及文件操作由现有注入装置隔离，不执行真实发布操作。
- `src-tauri/src/db/sqlserver_objects.rs:626`：用具名内部结构 `SqlServerCompletionForeignKeyAgg` 替代复杂的聚合元组，以字段表达外键信息、列和完整性；保持按 object_id 聚合及输出顺序、组合外键按 ordinal 排序、任一行缺失则丢弃整个约束的现有语义。未更改 SQL，没有增加循环 SQL，没有禁用检查规则。

## 测试先行证据

1. 修复前 `npm run lint` 退出 1，明确报告两项 `preserve-caught-error` 和一项 `URL no-undef`。
2. 修复前 `SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk npm run lint:rust` 退出 101，报告 `sqlserver_objects.rs:629` 的 `clippy::type_complexity`。
3. 仅补测试后运行 `npm run test:release`：42 项中 40 通过、2 失败。两项新增 cause 断言均观察到 actual 为 `undefined`，expected 为原始 `Error` 对象；完整中文提示断言已通过。随后才修改生产代码。

## 最终验证

所有最终命令退出码均为 0；Rust 命令均使用 `SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk`。

| 命令 | 结果 |
| --- | --- |
| `npm run test:release` | 42 通过，0 失败 |
| `npm run lint` | 通过，无错误或警告 |
| `cargo test --manifest-path src-tauri/Cargo.toml sqlserver_objects` | 15 通过，0 失败，787 过滤 |
| `npm run fmt:rust` | 通过（检查模式，未全仓写入格式化） |
| `npm run lint:rust` | 通过（`--all-targets -- -D warnings`） |
| `git diff --check -- scripts/release.mjs scripts/release.node-test.mjs src-tauri/src/db/sqlserver_objects.rs` | 通过 |

SQL Server 定向测试覆盖对象身份、跨 schema 目标、组合列顺序、丢弃不完整约束，以及既有索引/外键/触发器/routine 行为。全量前端与 Rust 测试由主代理统一执行，本报告不声称其已完成。

## 范围与风险

本任务属于仓库维护，不将静态检查既有错误归因于六个性能专项。变更规模小，现有 SQL 和对外数据结构未改；发布错误链新增可诊断信息，中文提示保持一致。未接入真实数据库或远端发布环境验证。

最终工作区还存在其他代理处理的 `docs/performance-baseline.md`、`docs/superpowers/plans/2026-09-30-performance-00-overview.md`、`src-tauri/vendor/mysql_async/DB_CONNECT_PATCH.md` 修改，本代理未编辑它们。原有未跟踪的 `docs/superpowers/plans/2026-10-13-performance-remaining-tasks.md` 保留。

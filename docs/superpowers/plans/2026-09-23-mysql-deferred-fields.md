# MySQL 大字段按需加载

目标：降低分页传输与前端内存，详情、编辑、复制和导出保持完整文本；预览永不作为写入值。

范围与协议：只改变 MySQL 表浏览，SQL 编辑器及其他数据库保持行为。可靠完整主键（包含复合主键）用于回查；无可靠主键/视图回退完整加载。主键不截断。默认隐藏列仍不查询。文本/JSON/字符串以及 BLOB/二进制列超过 4096 字节时使用最多 120 字符/字节预览。分页单元格以 {__deferred_field:true,preview:string,byte_length:number,kind:'text'|'binary'} 表示，NULL/短值保持原样。二进制内容沿用既有转换展示语义，延迟二进制字段仅查看，避免占位文本误写。

步骤：
1. 后端：复用集合元数据，数据库 SELECT 投影限制字段返回量并携带长度，转换明确标记。扩展 query_full_rows 可按完整主键集合批量回查指定列（默认仍 *），禁止循环 SQL；主键证据、INVISIBLE、Unicode、NULL 均保守处理。
2. 单元格：双击延迟字段打开加载弹窗，取完整值后才允许编辑；只读连接可查看；失败可重试；关闭/切页后迟到请求不能写状态或提交。
3. 主视图：集中批量回查/按主键匹配结果，校验缺失/重复结果。编辑比较使用完整原值。JSON/INSERT/Excel 获取完整字段；失败停止操作，保留选择与待提交值。
4. 验证：先写失败测试；后端投影与定位测试、UI 加载/失败/取消/只读测试、复制/导出测试。运行相关测试、TS build、Rust fmt/test/clippy，独立 review。

实现分工：子代理负责 Rust 后端与单元格 UI，主代理负责 TS 协议、批量完整值 helper、TableData 集成与集成测试。

## 完成与验证

- 已实现数据库端预览、完整值批量回查、编辑/复制/导出接入及页面失效保护。
- 独立审查发现并修复 StrictMode 重挂载、传统 DATE/DECIMAL 主键复制、INVISIBLE 主键匹配三项边界；补充 PostgreSQL 同形 JSON 对象兼容性回归。
- 前端全量测试：118 个文件、1277 项通过。最后补充完整行 JSON 兼容性后，相关 4 个文件 44 项回归通过。
- Rust 全量：686 项通过、12 项可选集成测试忽略。Rust fmt、Clippy、前端构建、修改文件 ESLint 及 diff 检查通过。
- 独立临时 MySQL 5.7 实测：约 26 KB 文本/JSON/二进制字段的分页载荷不足 1600 字节，按复合主键恢复完整 8001 字节 Unicode 文本。临时服务已停止；INVISIBLE 由单元测试覆盖，未在 MySQL 8 实测。
- 全仓 ESLint 另有 3 个既有错误：scripts/release.mjs 两处 preserve-caught-error，scripts/release.node-test.mjs 一处 no-undef；本次未修改这些文件。
- 保持当前 master 分支，未提交。

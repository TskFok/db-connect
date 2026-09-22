# 大表游标分页第一期实施计划

> 执行依据：用户已确认上一轮影响评估中的第一期建议，并要求实现。使用当前 master 分支，不新建分支，不提交或推送。

**目标：** MySQL、PostgreSQL 在单列整数主键升降序浏览时支持上一页、下一页游标分页；跳页、刷新、写后重载使用 OFFSET 重建边界。

**范围：** 默认无排序时采用整数主键 ASC；仅排序该主键时采用用户方向。多列排序、其他列排序、无整数单列主键、其他引擎保留原分页行为。用户数据库无需迁移。

**架构：** 后端确认真实主键和整数类型，在展示值转换前生成无损游标；游标绑定连接、表、筛选、排序和页大小。前端把游标与成功返回的页面绑定，缓存、失效和请求竞态统一处理。原 QueryResult 保持不变，表浏览使用扩展响应。

## 接口约定

`queryTableData` 在现有参数后添加可选 `navigation: TablePageNavigation`，Tauri 参数名也为 `navigation`：

```ts
type TablePageNavigation = { direction: "next" | "previous"; cursor: string };
interface TablePageResult extends QueryResult {
  pagination?: {
    mode: "offset" | "keyset";
    sort_column: string;
    sort_order: "ASC" | "DESC";
    next_cursor: string | null;
    previous_cursor: string | null;
  } | null;
  executed_sql?: string | null;
}
```

Store 增加 `pagination`、`executedSql` 和成功页上下文，`setPage(page, direction?)` 仅显式方向且与成功页相邻时使用游标。普通 `setPage(page)`、重复 loadData、CRUD 都走 OFFSET。后端不接受未验证文本作为 SQL 值。

## 全局约束

- 中文界面与文档；当前分支修改。
- 禁止循环内查询 SQL；主键元数据采用集合查询，按表复用，刷新重建。
- 不依赖前端展示数值、不扩展编辑能力、不改其他数据库语义。
- 所有成功的 OFFSET 页面也返回可用边界；上一页反向查询并恢复展示顺序。
- 新代码有回归测试，先观察关键测试失败，再实施。

## 任务与验证

- [x] 后端：新增游标计划/编码、元数据与 MySQL/PostgreSQL 集成；测试方向、范围、筛选括号、上下文失效、整数边界、复合键及不支持排序回退；在内存数据库对真实结果验证前进/后退/跳页续翻。
- [x] Store：缓存游标和实际 SQL，导航与重载分离；测试首次加载、跳页、排序/筛选/页大小失效、连续请求、迟到响应、失败恢复、切表、CRUD 重载。
- [x] 接口与 UI：添加扩展类型，上一/下一按钮传方向，随机跳页不传方向，加载时禁用翻页；SQL 预览使用后端实际 SQL；测试按钮导航和预览。
- [x] 集成：运行前端测试、构建、lint，Rust 测试、fmt、clippy；独立审查后修复发现。
- [x] 文档：说明支持条件、回退规则、并发变化边界与验证结果。

## 审查重点

1. 大于 JS 安全整数的主键无精度丢失，负数/无符号边界不越界。
2. 快速翻页时新页码不误用旧页游标，迟到响应不覆盖新表或新筛选。
3. 刷新/显示隐藏列/写后重载不会继续沿上次导航前进。
4. OFFSET 与 keyset 使用同一有效排序和筛选括号，上一页恢复正向行序。
5. ClickHouse、SQLite、SQL Server、复合主键及非主键排序不被误启用。

## 进度

- 已完成现状和官方文档评估；工作树初始干净。
- 决策：沿用用户已经确认的第一期设计直接实施；前后端按上述契约并行，最终统一审查。
- 前端定向测试：Store 75 例、UI/接口与已有选择测试通过；已覆盖真实组件与 Store 串联前进、后退、跳页后继续翻页。
- 审查修复：后台 CRUD 迟到覆盖、已关闭表缓存复活、切表保存未完成页码、旧筛选 COUNT 污染新快照。
- 后端审查要求：MySQL 从文本协议字节值严格解析整数；保留查询协议避免非排序时间列丢精度；用完整 PRIMARY 索引证明键列数量，不能对权限过滤后的列子集计数。
- 后端审查修复已验证：文本协议整数与完整主键证据回归先红后绿；14 项共享分页定向测试通过。MySQL、PostgreSQL 均只将严格解析后的原生整数规范化为十进制边界，保留文本查询协议及任意非主键列的既有展示。
- 完整前端测试：`npm test -- --maxWorkers=2`，115 文件、1249 项通过。默认并发首次运行中 `TableStructureColumnDefaults` 与 `TableStructureSqlPreview` 各一项超时；降低测试并发后全量通过，未增加超时或改测试条件。
- `npm run build` 通过；本次修改的前端文件 ESLint 和 Prettier 检查通过。全仓 `npm run lint` 仍有未修改的发布脚本既有问题：`scripts/release.mjs:203,211` 缺少 error cause，`scripts/release.node-test.mjs:382` 的 URL 未声明。
- Rust 全量测试首次运行有 7 项模拟 PostgreSQL 服务测试被沙箱禁止绑定本机端口；允许本机监听后离线运行通过。未连接真实 MySQL/PostgreSQL 服务器，也未测量真实大表性能。
- 最终 Rust 验证：`cargo test --offline --manifest-path src-tauri/Cargo.toml`，675 通过、11 按原配置忽略、0 失败；`cargo clippy --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`、fmt、diff check 均通过。已删除被共享计划替代的旧 MySQL/PostgreSQL 分页方法及重复测试断言，消除 dead_code。
- 工作保留在原 `master` 分支，未提交或推送。

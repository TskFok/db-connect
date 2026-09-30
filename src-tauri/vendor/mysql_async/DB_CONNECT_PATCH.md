# mysql_async 0.37.0 本地补丁

来源：crates.io `mysql_async` 0.37.0，保留上游源码和双许可证。没有升级版本或增加运行时依赖。

原 crates.io 包校验和（来自修改前 Cargo.lock）：`3519e91b0d254ac1ffa495bc42053286cb2172ad7241d5b3b1b9f8a891f21ee2`。排除本机 registry 元数据及上游开发用 Cargo.lock，应用仍由项目自身 Cargo.lock 锁定依赖。

唯一源码差异：`src/conn/mod.rs` 增加 `Conn::disconnect_immediately(self)`，同步标记 disconnected 并取走底层流。池回收器继续维护计数，但不会复用或后台排空这个连接。

原因：原版 `disconnect()` 会先调用 `clean_dirty()`；跨结果集时 `routine()` 会将 disconnected 恢复为 false。第二个结果流停顿时，外层超时不能保证连接槽位释放。应用层无公开 socket 或强制关闭入口。不能通过扩池、增加 KILL SQL、修改私有布局或故意 panic 规避。

验证：`mysql_query_budget_error_discards_stalled_multi_result_connection` 用本机协议替身提供 100001 行及停顿的第二结果集；原版会因超时后槽位仍被占用而失败，补丁直接丢弃流后通过。

仅 SQL 编辑器的取消/错误清理使用新接口；原版 disconnect、正常归还、会话初始化及表浏览取消路径不变。未来上游提供同等公开能力后，可移除此目录及 `[patch.crates-io]`，切回锁定的上游实现。

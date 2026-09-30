pub mod adapter;
pub mod batch_update;
pub mod clickhouse;
pub mod connection;
pub mod dialect;
pub(crate) mod metadata_batch;
pub mod mysql_deferred_fields;
pub mod mysql_query;
pub mod postgres;
pub mod postgres_ddl;
pub mod postgres_error;
pub mod postgres_objects;
pub mod result_budget;
pub mod schema_compare;
pub mod schema_sync;
pub mod sql_script;
pub mod sql_utils;
pub mod sqlite;
pub mod sqlserver;
pub mod sqlserver_ddl;
pub mod sqlserver_objects;
pub mod ssh_tunnel;
pub mod table_pagination;
pub mod table_query;

#[cfg(test)]
mod metadata_bench_tests;
#[cfg(test)]
mod metadata_mysql8_tests;
#[cfg(test)]
mod metadata_pg_tests;

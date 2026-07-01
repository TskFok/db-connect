mod commands;
mod crypto;
mod db;
mod models;
mod util;

use commands::{
    connection, data, database, file_io, foreign_key, github_issue, index_cmd, preferences,
    routine_event, runtime, sql_file, trigger,
};
use db::connection::ConnectionManager;
use db::postgres::PostgresCancelHandle;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone)]
pub enum RunningQuery {
    MySqlThread(u64),
    Postgres(Box<PostgresCancelHandle>),
    SqlServerUnsupported,
}

pub struct AppState {
    pub connection_manager: Arc<Mutex<ConnectionManager>>,
    /// 正在执行的查询：执行令牌（execution_id）-> 数据库特定取消句柄。
    pub running_queries: Arc<Mutex<HashMap<String, RunningQuery>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            connection_manager: Arc::new(Mutex::new(ConnectionManager::new())),
            running_queries: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            connection::test_connection,
            connection::connect,
            connection::disconnect,
            connection::ping_connection,
            connection::force_disconnect,
            connection::check_idle_disconnect,
            connection::save_connection,
            connection::list_saved_connections,
            connection::list_connection_groups,
            connection::create_connection_group,
            connection::rename_connection_group,
            connection::delete_connection_group,
            connection::set_connection_group_collapsed,
            connection::reorder_connection_groups,
            connection::move_connection_to_group,
            connection::get_decrypted_connection,
            connection::delete_saved_connection,
            connection::reorder_connections,
            connection::export_connections,
            connection::import_connections,
            runtime::get_runtime_info,
            github_issue::create_github_issue,
            file_io::write_text_file,
            file_io::write_binary_file,
            preferences::get_table_column_settings,
            preferences::save_table_column_settings,
            preferences::delete_table_column_settings,
            database::list_databases,
            database::list_tables,
            database::get_table_structure,
            database::get_sql_completion_metadata,
            database::get_table_definition,
            database::get_database_info,
            database::alter_database_charset,
            database::create_database,
            database::drop_database,
            database::rename_database,
            database::rename_table,
            database::alter_table_engine,
            database::get_primary_keys,
            database::column_ops::alter_column,
            database::column_ops::add_column,
            database::column_ops::drop_column,
            database::create_table,
            database::drop_table,
            database::truncate_table,
            data::query_table_data,
            data::query_table_count,
            data::insert_row,
            data::update_row,
            data::batch_update_rows,
            data::delete_rows,
            data::query_full_rows,
            data::execute_sql,
            data::cancel_query,
            data::get_session_info,
            data::explain_sql,
            sql_file::import_sql_file,
            sql_file::export_database_to_file,
            index_cmd::list_indexes,
            index_cmd::create_index,
            index_cmd::delete_index,
            trigger::list_triggers,
            trigger::get_trigger_definition,
            trigger::create_trigger,
            trigger::drop_trigger,
            foreign_key::list_foreign_keys,
            foreign_key::add_foreign_key,
            foreign_key::drop_foreign_key,
            routine_event::list_routines,
            routine_event::get_routine_definition,
            routine_event::drop_routine,
            routine_event::list_events,
            routine_event::get_event_definition,
            routine_event::drop_event,
            routine_event::set_event_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

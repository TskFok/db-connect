mod commands;
mod crypto;
mod db;
mod models;
#[cfg(feature = "performance-desktop")]
mod performance_desktop;
mod util;

use commands::{
    connection, data, database, database_compare, database_sync, file_io, foreign_key,
    github_issue, index_cmd, preferences, routine_event, runtime, sql_file, trigger,
};
use db::connection::ConnectionManager;
use db::postgres::PostgresCancelHandle;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tokio::sync::Mutex;

#[derive(Clone)]
pub enum RunningQuery {
    Postgres(Box<PostgresCancelHandle>),
    SqlServerUnsupported,
    ClickHouseUnsupported,
}

pub struct AppState {
    pub data_tasks: Arc<commands::data_tasks::DataTaskRuntime>,
    pub connection_manager: Arc<Mutex<ConnectionManager>>,
    /// 正在执行的查询：执行令牌（execution_id）-> 数据库特定取消句柄。
    pub running_queries: Arc<Mutex<HashMap<String, RunningQuery>>>,
    /// 表数据/行数查询的取消状态，按连接和执行标识隔离。
    pub table_queries: db::table_query::TableQueryRegistry,
    /// SQL 编辑器 MySQL 查询生命周期，按连接和执行标识隔离。
    pub mysql_queries: db::mysql_query::MysqlQueryRegistry,
    /// 正在导出的 SQL 文件：导出令牌（export_id）-> 协作式取消标记。
    pub running_sql_exports: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    /// 尚未领取的二进制文件导出，最多保留一个有效的一次性 ID。
    pub binary_exports: file_io::BinaryExportRegistry,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            data_tasks: Arc::new(commands::data_tasks::DataTaskRuntime::default()),
            connection_manager: Arc::new(Mutex::new(ConnectionManager::new())),
            running_queries: Arc::new(Mutex::new(HashMap::new())),
            table_queries: db::table_query::TableQueryRegistry::default(),
            mysql_queries: db::mysql_query::MysqlQueryRegistry::default(),
            running_sql_exports: Arc::new(Mutex::new(HashMap::new())),
            binary_exports: file_io::BinaryExportRegistry::default(),
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
    let context = tauri::generate_context!();
    #[cfg(feature = "performance-desktop")]
    let context = {
        let mut context = context;
        performance_desktop::initialize(&context.config().identifier)
            .expect("完整应用验收隔离校验失败，拒绝启动");
        performance_desktop::configure_window_storage(context.config_mut())
            .expect("完整应用验收 WebView 存储隔离失败，拒绝启动");
        context
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .setup(|app| {
            let runtime=app.state::<AppState>().data_tasks.clone();
            if runtime.initialize(app.handle()).is_err() {
                eprintln!("数据任务历史初始化失败，数据任务入口将提示目录错误");
            }
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    runtime.maintenance();
                }
            });
            Ok(())
        })
        .on_window_event(|window,event| {
            if let tauri::WindowEvent::CloseRequested{api,..}=event {
                if window.state::<AppState>().data_tasks.registry.has_active() {
                    api.prevent_close();
                    let _=window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::data_tasks::get_data_task_capabilities,
            commands::data_tasks::start_data_task_preview,
            commands::data_tasks::get_data_task,
            commands::data_tasks::get_data_task_diff,
            commands::data_tasks::execute_data_task,
            commands::data_tasks::cancel_data_task,
            commands::data_tasks::list_data_tasks,
            commands::data_tasks::discard_data_task_preview,
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
            file_io::prepare_binary_export,
            file_io::write_binary_export,
            file_io::cancel_binary_export,
            preferences::get_table_column_settings,
            preferences::save_table_column_settings,
            preferences::delete_table_column_settings,
            database::list_databases,
            database::list_tables,
            database::list_tables_batch,
            database::invalidate_table_metadata_cache,
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
            database_compare::list_compare_databases,
            database_compare::compare_databases,
            database_sync::preview_database_sync,
            database_sync::execute_database_sync,
            database::get_primary_keys,
            database::column_ops::alter_column,
            database::column_ops::add_column,
            database::structure_preview::preview_add_column,
            database::structure_preview::preview_alter_column,
            database::structure_preview::preview_table_properties,
            database::structure_preview::preview_create_table,
            database::column_ops::drop_column,
            database::create_table,
            database::drop_table,
            database::truncate_table,
            data::query_table_data,
            data::query_table_count,
            data::cancel_table_query,
            data::insert_row,
            data::update_row,
            data::batch_update_rows,
            data::delete_rows,
            data::query_full_rows,
            data::execute_sql,
            data::cancel_query,
            data::get_session_info,
            data::explain_sql,
            sql_file::preview_sql_file_import,
            sql_file::import_sql_file,
            sql_file::export_database_to_file,
            sql_file::cancel_sql_export,
            index_cmd::list_indexes,
            index_cmd::create_index,
            index_cmd::preview_index,
            index_cmd::delete_index,
            trigger::list_triggers,
            trigger::get_trigger_definition,
            trigger::create_trigger,
            trigger::preview_trigger,
            trigger::drop_trigger,
            foreign_key::list_foreign_keys,
            foreign_key::get_sql_completion_foreign_keys,
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
        .build(context)
        .expect("error while building tauri application")
        .run(|app,event| match event {
            tauri::RunEvent::ExitRequested{api,..}=>{
                let runtime=app.state::<AppState>().data_tasks.clone();
                if runtime.registry.has_active() {
                    api.prevent_exit();
                    if !runtime.exit_prompt_open.swap(true,std::sync::atomic::Ordering::AcqRel) {
                        let handle=app.clone();
                        app.dialog().message("仍有数据任务运行。继续等待可留在应用；取消任务后退出会等待回滚或提交结果得到确认。")
                            .title("数据任务尚未结束")
                            .buttons(MessageDialogButtons::OkCancelCustom("取消任务后退出".into(),"继续等待".into()))
                            .show(move |cancel| {
                                if cancel {
                                    runtime.cancel_all(&handle);
                                    tauri::async_runtime::spawn(async move {
                                        while runtime.registry.has_active() {tokio::time::sleep(std::time::Duration::from_millis(200)).await;}
                                        handle.exit(0);
                                    });
                                }else{runtime.exit_prompt_open.store(false,std::sync::atomic::Ordering::Release);}
                            });
                    }
                }
            },
            #[cfg(target_os="macos")]
            tauri::RunEvent::Reopen{..}=>{if let Some(window)=app.get_webview_window("main") {let _=window.show();let _=window.set_focus();}},
            _=>{}
        });
}

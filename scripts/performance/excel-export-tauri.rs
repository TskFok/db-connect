//! 由 excel-export-tauri.mjs 复制到临时 Cargo example；不启动主应用或读取用户连接配置。
#[path = "../src/commands/file_io.rs"]
mod file_io;

use serde::Serialize;
use std::path::PathBuf;
use std::time::Instant;
use tauri::{AppHandle, State};

pub struct AppState {
    pub binary_exports: file_io::BinaryExportRegistry,
}

struct BenchmarkState {
    directory: PathBuf,
    result_path: PathBuf,
    repetitions: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkConfig {
    path: String,
    missing_parent_path: String,
    read_only_path: String,
    worker_path: String,
    repetitions: usize,
}

#[tauri::command]
fn benchmark_config(state: State<'_, BenchmarkState>) -> BenchmarkConfig {
    BenchmarkConfig {
        path: state
            .directory
            .join("中文 空格导出.bin")
            .to_string_lossy()
            .into_owned(),
        missing_parent_path: state
            .directory
            .join("不存在的目录/错误.bin")
            .to_string_lossy()
            .into_owned(),
        read_only_path: state
            .directory
            .join("只读 文件.bin")
            .to_string_lossy()
            .into_owned(),
        worker_path: state
            .directory
            .join("真实 Worker 导出.xlsx")
            .to_string_lossy()
            .into_owned(),
        repetitions: state.repetitions,
    }
}

#[tauri::command]
async fn benchmark_write(
    request: tauri::ipc::Request<'_>,
    state: State<'_, AppState>,
) -> Result<f64, String> {
    let started = Instant::now();
    file_io::write_binary_export(request, state).await?;
    Ok(started.elapsed().as_secs_f64() * 1000.0)
}

#[tauri::command]
async fn benchmark_disk_write(
    length: usize,
    state: State<'_, BenchmarkState>,
) -> Result<f64, String> {
    let path = state.directory.join("独立磁盘微基准.bin");
    // 合成数据准备、缓冲区分配和阻塞线程排队均位于磁盘计时之外。
    let bytes: Vec<u8> = (0..length).map(|index| index as u8).collect();
    tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        std::fs::write(path, &bytes).map_err(|error| error.to_string())?;
        Ok(started.elapsed().as_secs_f64() * 1000.0)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn benchmark_verify(length: usize, state: State<'_, BenchmarkState>) -> Result<(), String> {
    let bytes = std::fs::read(state.directory.join("中文 空格导出.bin"))
        .map_err(|error| error.to_string())?;
    if bytes.len() != length
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| *byte == index as u8)
    {
        return Err("真实落盘内容与固定二进制夹具不一致".to_owned());
    }
    Ok(())
}

#[tauri::command]
fn benchmark_phase(phase: String) {
    println!("PHASE:{phase}");
}

#[tauri::command]
fn benchmark_finish(
    result: serde_json::Value,
    state: State<'_, BenchmarkState>,
    app: AppHandle,
) -> Result<(), String> {
    std::fs::write(
        &state.result_path,
        serde_json::to_vec_pretty(&result).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    app.exit(if result.get("error").is_some() { 1 } else { 0 });
    Ok(())
}

fn main() {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    assert_eq!(arguments.len(), 3, "参数：临时目录 结果路径 重复次数");
    let directory = PathBuf::from(&arguments[0]);
    let repetitions: usize = arguments[2]
        .to_string_lossy()
        .parse()
        .expect("重复次数必须为整数");
    tauri::Builder::default()
        .manage(AppState {
            binary_exports: file_io::BinaryExportRegistry::default(),
        })
        .manage(BenchmarkState {
            directory,
            result_path: PathBuf::from(&arguments[1]),
            repetitions,
        })
        .invoke_handler(tauri::generate_handler![
            file_io::prepare_binary_export,
            file_io::write_binary_export,
            file_io::cancel_binary_export,
            file_io::write_text_file,
            benchmark_config,
            benchmark_write,
            benchmark_disk_write,
            benchmark_verify,
            benchmark_phase,
            benchmark_finish,
        ])
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "excel-ipc-benchmark",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Excel 二进制 IPC 隔离基准")
            .inner_size(640.0, 240.0)
            .incognito(true)
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!("__BENCHMARK_CONFIG_PATH__"))
        .expect("独立 Tauri 基准启动失败");
}

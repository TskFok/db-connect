#!/usr/bin/env bash
set -euo pipefail
# 独立 Tauri example，不启动主应用。默认 debug / 5 次预热 / 20 次正式。
# EXCEL_TAURI_PROFILE=debug|release EXCEL_TAURI_WARMUPS=5 EXCEL_TAURI_REPETITIONS=20
#   bash scripts/performance/excel-export-tauri.sh [结果.json]
repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
run_dir="$(mktemp -d /tmp/excel-export-tauri.XXXXXX)"
output_path="${1:-${run_dir}/result.json}"
cd "$repo_dir"
node scripts/performance/excel-export-tauri.mjs "$run_dir" "$output_path"

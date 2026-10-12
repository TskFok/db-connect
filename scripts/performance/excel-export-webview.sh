#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
run_dir="$(mktemp -d /tmp/excel-export-webview.XXXXXX)"
output_path="${1:-${run_dir}/result.json}"
module_cache="${EXCEL_WEBVIEW_SWIFT_CACHE:-/tmp/excel-export-webview-module-cache}"
cd "$repo_dir"
CLANG_MODULE_CACHE_PATH="$module_cache" SWIFT_MODULE_CACHE_PATH="$module_cache" \
  swiftc -target "$(uname -m)-apple-macosx$(sw_vers -productVersion)" \
  scripts/performance/excel-export-webview.swift -o "$run_dir/excel-export-webview"
node scripts/performance/excel-export-webview.mjs "$run_dir" "$output_path"

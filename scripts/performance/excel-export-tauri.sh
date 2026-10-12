#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
run_dir="$(mktemp -d /tmp/excel-export-tauri.XXXXXX)"
output_path="${1:-${run_dir}/result.json}"
cd "$repo_dir"
node scripts/performance/excel-export-tauri.mjs "$run_dir" "$output_path"

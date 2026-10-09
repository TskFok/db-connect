#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
run_dir="$(mktemp -d /tmp/frontend-interaction-webview.XXXXXX)"
output_path="${1:-${run_dir}/webview-raw.json}"
port="${FRONTEND_INTERACTION_WEBVIEW_PORT:-14287}"
swift_binary="${run_dir}/frontend-interaction-webview"
vite_log="${run_dir}/vite.log"
module_cache="${FRONTEND_INTERACTION_SWIFT_CACHE:-/tmp/frontend-interaction-webview-module-cache}"
baseline_source="${repo_dir}/scripts/performance/frontend-interaction-baseline.generated.tsx"
baseline_ref="${FRONTEND_INTERACTION_BASELINE_REF:-498fa79d5789b91c957120c27f77c44829d06e4c}"
cleanup() {
  for task_pid in "${swift_pid:-}" "${vite_pid:-}"; do
    if [[ -n "$task_pid" ]]; then kill "$task_pid" 2>/dev/null || true; wait "$task_pid" 2>/dev/null || true; fi
  done
  rm -f "$swift_binary"
  if [[ "${baseline_owned:-0}" == "1" ]]; then rm -f "$baseline_source"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
cd "$repo_dir"
baseline_commit="$(git rev-parse --verify "${baseline_ref}^{commit}")"
# noclobber reserves the import path atomically; never overwrite/remove another run.
if ! (set -o noclobber; : > "$baseline_source") 2>/dev/null; then
  echo "Baseline source already exists: $baseline_source" >&2
  exit 2
fi
baseline_owned=1
git show "${baseline_commit}:src/components/table/VirtualDataTable.tsx" > "$baseline_source"
CLANG_MODULE_CACHE_PATH="$module_cache" SWIFT_MODULE_CACHE_PATH="$module_cache" \
 swiftc -target "$(uname -m)-apple-macosx$(sw_vers -productVersion)" \
 scripts/performance/frontend-interaction-webview.swift -o "$swift_binary"
./node_modules/.bin/vite --host 127.0.0.1 --port "$port" --strictPort >"$vite_log" 2>&1 &
vite_pid=$!
ready=0
for _ in {1..100}; do
  if ! kill -0 "$vite_pid" 2>/dev/null; then cat "$vite_log" >&2; exit 2; fi
  if rg -q "Local:.*http://127\\.0\\.0\\.1:${port}/" "$vite_log" && \
     curl --silent --fail "http://127.0.0.1:${port}/scripts/performance/frontend-interaction-webview.html" >/dev/null; then ready=1; break; fi
  sleep 0.1
done
if [[ "$ready" != 1 ]]; then cat "$vite_log" >&2; exit 2; fi
echo "WKWebView run directory: $run_dir" >&2
"$swift_binary" "http://127.0.0.1:${port}/scripts/performance/frontend-interaction-webview.html?baseline=${baseline_commit}${FRONTEND_INTERACTION_WEBVIEW_QUERY:-}" "$output_path" &
swift_pid=$!
wait "$swift_pid"

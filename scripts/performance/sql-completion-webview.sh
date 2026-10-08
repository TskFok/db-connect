#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
run_dir="$(mktemp -d /tmp/sql-completion-webview.XXXXXX)"
output_path="${1:-${run_dir}/webview-raw.json}"
port="${SQL_COMPLETION_WEBVIEW_PORT:-14286}"
swift_binary="${run_dir}/sql-completion-webview"
vite_log="${run_dir}/vite.log"
module_cache="${run_dir}/module-cache"

cleanup() {
  if [[ -n "${swift_pid:-}" ]]; then
    kill "$swift_pid" 2>/dev/null || true
    wait "$swift_pid" 2>/dev/null || true
  fi
  if [[ -n "${vite_pid:-}" ]]; then
    kill "$vite_pid" 2>/dev/null || true
    wait "$vite_pid" 2>/dev/null || true
  fi
  rm -f "$swift_binary"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

cd "$repo_dir"
CLANG_MODULE_CACHE_PATH="$module_cache" SWIFT_MODULE_CACHE_PATH="$module_cache" \
  swiftc -target "$(uname -m)-apple-macosx$(sw_vers -productVersion)" \
  scripts/performance/sql-completion-webview.swift -o "$swift_binary"
./node_modules/.bin/vite --host 127.0.0.1 --port "$port" --strictPort >"$vite_log" 2>&1 &
vite_pid=$!
ready=0
for _ in {1..100}; do
  if ! kill -0 "$vite_pid" 2>/dev/null; then cat "$vite_log" >&2; exit 2; fi
  if grep -Eq "Local:.*http://127\\.0\\.0\\.1:${port}/" "$vite_log" && \
     curl --silent --fail "http://127.0.0.1:${port}/scripts/performance/sql-completion-webview.html" >/dev/null; then
    if ! kill -0 "$vite_pid" 2>/dev/null; then cat "$vite_log" >&2; exit 2; fi
    ready=1
    break
  fi
  sleep 0.1
done
if [[ "$ready" != 1 ]]; then cat "$vite_log" >&2; exit 2; fi
echo "WKWebView run directory: $run_dir" >&2
"$swift_binary" "http://127.0.0.1:${port}/scripts/performance/sql-completion-webview.html${SQL_COMPLETION_WEBVIEW_QUERY:-}" "$output_path" &
swift_pid=$!
wait "$swift_pid"

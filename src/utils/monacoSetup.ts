import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

let initialized = false;

/**
 * 配置 Monaco Editor 使用本地打包资源，而非默认 CDN。
 * Tauri CSP（script-src 'self'）会拦截 jsdelivr 脚本，导致 SQL 页出现未处理的 Promise 拒绝。
 */
export function setupMonacoEditor(): void {
  if (initialized) return;
  initialized = true;

  self.MonacoEnvironment = {
    getWorker() {
      return new editorWorker();
    },
  };

  loader.config({ monaco });
}

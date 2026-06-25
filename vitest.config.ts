import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appVersion = JSON.parse(
  readFileSync(join(__dirname, "package.json"), "utf-8")
).version as string;

const mocksDir = join(__dirname, "src/__tests__/mocks");

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: join(__dirname, "src/utils/monacoSetup.ts"),
        replacement: join(mocksDir, "monacoSetup.ts"),
      },
      {
        find: "@monaco-editor/react",
        replacement: join(mocksDir, "monacoEditorReact.tsx"),
      },
      {
        find: "monaco-editor/esm/vs/editor/editor.worker?worker",
        replacement: join(mocksDir, "monacoEditorWorker.ts"),
      },
      {
        find: "monaco-editor/esm/vs/editor/editor.worker",
        replacement: join(mocksDir, "monacoEditorWorker.ts"),
      },
      {
        find: "monaco-editor",
        replacement: join(mocksDir, "monacoEditorStub.ts"),
      },
      {
        find: join(__dirname, "src/components/sql/SqlEditorLazy.tsx"),
        replacement: join(mocksDir, "SqlEditorLazy.tsx"),
      },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    testTimeout: 10_000,
  },
});

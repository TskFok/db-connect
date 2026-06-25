import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appVersion = JSON.parse(
  readFileSync(join(__dirname, "package.json"), "utf-8")
).version as string;

const host = process.env.TAURI_DEV_HOST;
const manualChunkPackages = [
  { name: "antd", packages: ["antd", "@ant-design/icons"] },
  {
    name: "dnd",
    packages: ["@dnd-kit/core", "@dnd-kit/sortable", "@dnd-kit/utilities"],
  },
] as const;

function manualChunks(id: string) {
  const normalizedId = id.split("\\").join("/");

  for (const chunk of manualChunkPackages) {
    if (
      chunk.packages.some(
        (pkg) =>
          normalizedId.includes(`/node_modules/${pkg}/`) ||
          normalizedId.includes(`/node_modules/${pkg}.js`)
      )
    ) {
      return chunk.name;
    }
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [react()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        // 拆分大依赖到独立 chunk：改善浏览器缓存命中，并配合懒加载减小首屏体积。
        // monaco / mermaid / write-excel-file 已通过动态 import 自动分包，这里主要切分静态依赖。
        manualChunks,
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
});

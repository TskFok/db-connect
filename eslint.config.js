import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // 非源码目录不参与 lint
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/**",
      ".history/**",
      "coverage/**",
      "*.config.js",
      "*.config.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // Rules of Hooks 是硬性正确性约束，保持为 error
      "react-hooks/rules-of-hooks": "error",
      // 依赖数组缺失多为渐进式收敛项，降级为告警基线
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // 以下规则在现有大文件中较多，先以告警基线起步，逐步收敛
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["src/main.tsx", "src/__tests__/mocks/**/*.{ts,tsx}"],
    rules: {
      // 应用入口和测试 mock 不是可热刷新的组件模块，关闭此规则避免误报。
      "react-refresh/only-export-components": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
  },
  // 关闭与 Prettier 冲突的格式化类规则
  prettier
);

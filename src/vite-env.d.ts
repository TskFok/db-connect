/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 崩溃上报 GitHub 仓库，格式 owner/repo */
  readonly VITE_GITHUB_ISSUE_REPO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

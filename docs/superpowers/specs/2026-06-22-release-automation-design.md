# 发布自动化设计

## 背景

当前项目是 Tauri 2 + React + TypeScript 桌面应用，版本号分散在 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 和 `src/appVersion.ts`。现有 CI 会在 Linux、macOS、Windows 上执行测试和 `tauri build`，但没有一条从本地升版本到 GitHub Releases 发布多平台安装包的自动化路径。

## 目标

新增 `npm run release` 发布入口：

- 默认升级 patch 版本，例如 `0.1.0 -> 0.1.1`。
- 支持 `npm run release -- minor`、`npm run release -- major`、`npm run release -- 1.2.3`。
- 自动同步所有应用版本来源。
- 自动提交中文发布 commit，并推送当前分支。
- 推送到 GitHub 后自动创建 `vX.Y.Z` tag。
- 自动构建 macOS、Windows、Linux 多平台 Tauri 安装包。
- 自动创建公开 GitHub Release，并上传构建产物。

## 非目标

- 不新建分支，发布脚本只在当前分支工作。
- 不做 npm 包发布。
- 不做 Windows 或 macOS 代码签名、 notarization、自动更新器配置。
- 不在循环遍历中增加 SQL 查询；本改动不涉及数据库查询。

## 本地发布脚本

新增 `scripts/release.mjs`，并在 `package.json` 中新增：

```json
"release": "node scripts/release.mjs"
```

脚本流程：

1. 检查当前目录是 Git 工作区，并读取当前分支。
2. 检查工作区必须干净，避免把用户未提交改动混入发布 commit。
3. 读取当前 `package.json` 版本。
4. 根据参数计算新版本：
   - 无参数或 `patch`：补丁版本加 1。
   - `minor`：小版本加 1，patch 归零。
   - `major`：大版本加 1，minor 和 patch 归零。
   - `X.Y.Z`：使用指定语义化版本。
5. 校验新版本必须大于当前版本。
6. 同步写入：
   - `package.json`
   - `package-lock.json` 顶层版本和 root package 版本
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml` 的包版本
   - `src/appVersion.ts` 的 fallback 默认版本
7. 执行轻量校验，至少包含版本一致性检查；完整测试交给 CI。
8. `git add` 版本相关文件。
9. `git commit -m "发布 vX.Y.Z"`。
10. `git push origin 当前分支`。

版本写入前的检查失败时立即退出，不修改文件。版本写入后若 commit 失败，保留本地版本文件改动供用户处理；若 push 失败，保留已经创建的本地发布 commit，并提示用户修复网络或远端权限后重新推送当前分支。若远端没有 `origin` 或当前分支没有上游，提示用户先配置远端。

## GitHub Actions 发布流程

新增 `.github/workflows/release.yml`。工作流监听 `master` 和 `main` 的 push，但只在 head commit message 匹配 `发布 vX.Y.Z` 时执行，避免普通提交触发发布。

工作流设计：

- 权限使用最小可用范围：`contents: write`，用于创建 tag、Release 和上传资产。
- 使用矩阵构建：
  - `macos-latest` + `--target aarch64-apple-darwin`
  - `macos-latest` + `--target x86_64-apple-darwin`
  - `ubuntu-22.04`
  - `windows-latest`
- Linux runner 安装 Tauri 需要的 WebKitGTK、appindicator、rsvg、patchelf 等系统依赖。
- 使用 Node 22，与现有 CI 保持一致，并通过 `npm ci` 安装依赖。
- 安装 Rust stable；macOS runner 额外安装两个 macOS target。
- 使用 `Swatinem/rust-cache` 缓存 Rust 构建产物。
- 在调用 Tauri action 前检查 `vX.Y.Z` tag 和对应 Release 是否已经存在；存在时直接失败，避免向旧发布追加资产。
- 使用 `tauri-apps/tauri-action` 执行 `tauri build`，创建或复用 `v__VERSION__` tag，公开发布 `MySQL Connect v__VERSION__` Release，并上传各平台 bundle。
- `releaseDraft: false`，发布后直接公开。
- `prerelease: false`。
- `generateReleaseNotes: true`，由 GitHub 自动生成发布说明。

`tauri-action` 会根据应用版本替换 `__VERSION__`。重复版本由前置检查拦截并报错。

## 错误处理

本地脚本：

- 参数不是 `patch`、`minor`、`major` 或 `X.Y.Z` 时失败。
- 新版本不大于当前版本时失败。
- 工作区不干净时失败。
- 版本文件解析失败时失败。
- Git commit 或 push 失败时保留本地改动，由用户按错误信息处理。

GitHub Actions：

- 只允许发布 commit 触发。
- 任一平台构建失败时整个发布流程失败。
- Release 直接公开。矩阵并发上传到同一 Release 时，若部分平台已上传而其他平台失败，可能留下不完整 Release；失败后需要维护者在 GitHub Releases 中人工检查或删除不完整 Release。

## 测试

新增或调整验证：

- `npm run release -- --dry-run patch` 或等价内部测试入口，验证版本计算和文件同步，不产生 commit。
- 脚本单元级逻辑可通过 Node 直接测试版本计算函数。
- 运行 `npm run build` 验证前端可读取更新后的版本。
- 保留现有 CI 对 lint、前端单测、Rust 格式、clippy、Rust 单测和 Tauri build 的覆盖。

## 文档

更新 README 的打包说明，补充：

- `npm run release` 默认发布 patch。
- 可通过 `npm run release -- minor`、`npm run release -- major`、`npm run release -- 1.2.3` 指定版本升级方式。
- 发布脚本会提交并推送当前分支。
- GitHub Actions 完成后可在 Releases 页面下载多平台安装包。

## 参考

- Tauri GitHub 发布流水线：`https://v2.tauri.app/distribute/pipelines/github/`
- `tauri-apps/tauri-action`：`https://github.com/tauri-apps/tauri-action`
- GitHub `GITHUB_TOKEN` 权限：`https://docs.github.com/en/actions/tutorials/authenticate-with-github_token`

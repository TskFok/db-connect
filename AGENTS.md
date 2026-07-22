# Agent 指南

## 提交信息规范

采用 [Conventional Commits](https://www.conventionalcommits.org/)：英文 type 开头，中文描述，简短明确。

```
<type>: <中文描述>
```

| type | 用途 |
|------|------|
| `feat` | 新功能 |
| `fix` | 修 bug |
| `refactor` | 重构 |
| `chore` | 日常维护 |
| `ci` | GitHub Actions / 部署配置 |
| `build` | 依赖 / 构建变更 |
| `docs` | 文档 |
| `test` | 测试 |

### 示例

```
feat: 支持连接分组拖拽排序
fix: 修复 SSH 隧道连接超时未提示
refactor: 抽取连接池 TTL 配置
ci: 增加 release 工作流多平台矩阵
docs: 补充发布流程说明
```

### 版本发布提交

`npm run release` 自动生成的版本提交使用固定格式，不参与 changelog 分组：

```
发布：vX.Y.Z
```

## Release Notes

已配置 [Release Drafter](https://github.com/release-drafter/release-drafter)（`.github/release-drafter.yml`）：

- **master/main push**：更新 Draft Release
- **PR 打开/更新**：按标题前缀自动打 label（`feat:`、`fix:` 等）
- **tag 发布**（`release.yml`）：发布 Draft 为正式 Release，Tauri 仅上传安装包

按 type 分组：

- **Features** ← `feat`
- **Bug Fixes** ← `fix`
- **Refactors** ← `refactor`
- **Documentation** ← `docs`
- **Tests** ← `test`
- **Build System** ← `build`
- **Continuous Integration** ← `ci`
- **Miscellaneous** ← `chore`

PR 标题需符合提交规范，以便 autolabeler 正确分类。可给 PR 加 `skip-changelog` label 排除出 Release Notes。

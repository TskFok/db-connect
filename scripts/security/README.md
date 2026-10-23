# 前端安全依赖

## Monaco 内嵌 DOMPurify

Monaco Editor 0.55.1 的 ESM 入口内嵌 DOMPurify 3.2.7，`npm overrides` 无法更新这份源码。`patch-monaco-dompurify.mjs` 将该文件替换为直接依赖 `dompurify@3.4.17` 的官方 `dist/purify.es.mjs`，只移除失效的 source map 注释，保留许可证。

- 原始入口：`monaco-editor/esm/vs/base/browser/dompurify/dompurify.js`。
- 原始 SHA-256：`9b2835fc7de5bd37faff156e83bf060067577a1f09c6620d9f37d5fa5e5970b1`。
- 上游来源：[DOMPurify 3.4.17](https://github.com/cure53/DOMPurify/tree/3.4.17)。npm 下载完整性由 `package-lock.json` 记录。
- 版本与内容不符合已审查的契约时，脚本报错并停止，避免升级时悄悄失效。
- 整份 ESM 模块独立执行，Monaco 与 Mermaid 保持各自的 DOMPurify 实例，不共享配置或 hooks。
- `postinstall`、开发、构建和测试命令都会准备补丁；Vite 配置也导入该脚本，因此直接运行 Vite 仍会准备补丁。
- 应用使用 `src/utils/monacoSetup.ts` 的 ESM 导入；不加载 Monaco 包里的预打包 AMD/UMD 文件。后者未修改，不应作为应用的新入口使用。

升级 Monaco 或 DOMPurify 时，重新检查嵌入文件路径、导出 API、独立实例、官方公告与原始 SHA-256，更新脚本中的版本约束后重跑：

```sh
npm ci --no-audit
npm run test:security
npm test
npm run build
npm run lint
```

`sanitizers.node-test.mjs` 执行实际嵌入文件，验证 [GHSA-v2wj-7wpq-c8vv](https://github.com/cure53/DOMPurify/security/advisories/GHSA-v2wj-7wpq-c8vv) 的原始文本上下文逃逸、合法提示内容和 hooks 隔离。补丁前的 3.2.7 在五项逃逸用例上失败，替换后通过。原始文本上下文用例是清洗器安全回归，不能据此推断应用当前存在相同的插入方式。

## Mermaid 与 KaTeX

保留 Mermaid 10.9.8，对其 KaTeX 子依赖定向覆盖到 0.18.2。应用导入的是 `mermaid.core.mjs`，该入口动态导入 npm `katex`，不使用 Mermaid 发布包中另附的旧版 KaTeX 预打包副本。`mermaidSecurity.test.ts` 使用真实 Mermaid、KaTeX 和清洗器渲染关系图、公式及危险 HTML，仅为 jsdom 补齐 SVG 测量。

不通过 `npm audit` 上传依赖树；公告库比对在本地完成。内嵌副本必须额外检查，不能以锁文件没有命中项代替该检查。

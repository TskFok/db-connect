import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { URL } from "node:url";
import { JSDOM } from "jsdom";

const dom = new JSDOM("");
globalThis.window = dom.window;
const source = await readFile(
  new URL(
    "../../node_modules/monaco-editor/esm/vs/base/browser/dompurify/dompurify.js",
    import.meta.url
  ),
  "utf8"
);
// 执行编辑器真正消费的内嵌模块；不能只检查 npm 中另一份 DOMPurify。
const { default: monacoPurify } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
const { default: mermaidPurify } = await import("dompurify");

after(() => {
  delete globalThis.window;
  dom.window.close();
});

for (const wrapper of ["xmp", "noscript", "iframe", "noembed", "noframes"]) {
  test(`Monaco 清洗后不保留可逃逸 ${wrapper} 的属性（GHSA-v2wj-7wpq-c8vv）`, () => {
    const dirty = `<img src=x alt="</${wrapper}><img src=x onerror=alert(1)>">`;
    const clean = monacoPurify.sanitize(dirty);
    const probe = dom.window.document.createElement("div");
    probe.innerHTML = `<${wrapper}>${clean}</${wrapper}>`;
    assert.equal(probe.querySelector("[onerror]"), null);
    assert.equal(clean, '<img src="x">');
  });
}

test("Monaco 保留合法提示内容并删除脚本、事件和危险链接", () => {
  const clean = monacoPurify.sanitize(
    '<p><strong>SELECT</strong> <code>users.id</code></p><img src=x onerror="alert(1)"><a href="javascript:alert(1)">链接</a><script>alert(1)</script>'
  );
  const probe = dom.window.document.createElement("div");
  probe.innerHTML = clean;
  assert.equal(probe.querySelector("strong")?.textContent, "SELECT");
  assert.equal(probe.querySelector("code")?.textContent, "users.id");
  assert.equal(probe.querySelector("script, [onerror], [href]"), null);
});

test("Monaco 拒绝返回含危险原始文本的已移除根节点（GHSA-6688-9rhm-gjv2）", () => {
  const style = dom.window.document.createElement("style");
  style.textContent = "</style><img src=x onerror=alert(1)>";
  dom.window.document.createDocumentFragment().append(style);
  assert.throws(
    () => monacoPurify.sanitize(style, { IN_PLACE: true }),
    TypeError
  );
});

test("Monaco 与 Mermaid 的清洗 hooks 相互隔离", () => {
  assert.notEqual(monacoPurify, mermaidPurify);
  mermaidPurify.addHook("afterSanitizeAttributes", (node) => {
    node.removeAttribute("title");
  });
  try {
    const input = '<span title="提示">内容</span>';
    assert.equal(mermaidPurify.sanitize(input), "<span>内容</span>");
    assert.equal(monacoPurify.sanitize(input), input);
    monacoPurify.removeAllHooks();
    assert.equal(mermaidPurify.sanitize(input), "<span>内容</span>");
  } finally {
    mermaidPurify.removeAllHooks();
    monacoPurify.removeAllHooks();
  }
});

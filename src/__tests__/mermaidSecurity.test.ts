import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import mermaid from "mermaid";
import katex from "katex";

describe("Mermaid 安全依赖升级兼容性", () => {
  const originalGetBBox = Object.getOwnPropertyDescriptor(
    SVGElement.prototype,
    "getBBox"
  );
  beforeAll(() => {
    // jsdom 缺少 SVG 几何测量；真实解析器、布局、KaTeX 和清洗器均参与运行。
    Object.defineProperty(SVGElement.prototype, "getBBox", {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 100, height: 20 }),
    });
  });

  afterAll(() => {
    if (originalGetBBox) {
      Object.defineProperty(SVGElement.prototype, "getBBox", originalGetBBox);
    } else {
      Reflect.deleteProperty(SVGElement.prototype, "getBBox");
    }
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("严格模式渲染合法关系图与公式，同时清除危险 HTML", async () => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      legacyMathML: true,
      flowchart: { htmlLabels: true },
    });
    const { svg } = await mermaid.render(
      "security-mermaid",
      'flowchart LR\n A["用户表"] --> B["$$x^2 + y^2$$"]\n C["<span onclick=alert(1)>标签</span>"]'
    );
    const host = document.createElement("div");
    host.innerHTML = svg;
    expect(host.querySelector("svg")).not.toBeNull();
    expect(host.textContent).toContain("用户表");
    expect(host.querySelector(".katex")).not.toBeNull();
    expect(host.querySelector("script, [onerror], [onclick]")).toBeNull();
  });

  it("KaTeX 非信任模式保留公式并拒绝 JavaScript 链接", () => {
    const host = document.createElement("div");
    host.innerHTML = katex.renderToString(
      String.raw`x^2 + \href{javascript:alert(1)}{危险链接}`,
      { trust: false, strict: "ignore" }
    );
    expect(host.querySelector(".katex")).not.toBeNull();
    expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});

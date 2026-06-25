import { useEffect, useRef, useState, useId } from "react";
import { Alert, Spin } from "antd";
import { useThemeStore } from "../../stores/themeStore";

type MermaidBlockProps = {
  /** Mermaid 源码（如 flowchart ...） */
  chart: string;
  /** 容器最小高度 */
  minHeight?: number;
};

/**
 * 在客户端将 Mermaid 源码渲染为 SVG，并随应用主题切换 default/dark。
 */
export function MermaidBlock({ chart, minHeight = 120 }: MermaidBlockProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const reactId = useId().replace(/:/g, "");
  const mode = useThemeStore((s) => s.mode);
  const isDark = mode === "dark";
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const el = hostRef.current;
    if (!el) return undefined;

    setError(null);
    setRendering(true);
    el.replaceChildren();

    const id = `mermaid-${reactId}-${performance.now().toFixed(0)}`;

    // 动态导入 mermaid：关系图为低频功能，避免该约 1MB 依赖进入首屏 bundle
    void import("mermaid")
      .then(({ default: mermaid }) => {
        if (cancelled) return undefined;
        mermaid.initialize({
          startOnLoad: false,
          theme: isDark ? "dark" : "default",
          securityLevel: "strict",
          fontFamily: "inherit",
          flowchart: {
            useMaxWidth: true,
            htmlLabels: true,
          },
        });
        return mermaid.render(id, chart);
      })
      .then((result) => {
        if (cancelled || !result || !hostRef.current) return;
        hostRef.current.innerHTML = result.svg;
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setRendering(false);
      });

    return () => {
      cancelled = true;
    };
  }, [chart, isDark, reactId]);

  return (
    <div className="mermaid-block">
      {error && (
        <Alert
          type="error"
          message="关系图渲染失败"
          description={error}
          showIcon
          style={{ marginBottom: 8 }}
        />
      )}
      <div style={{ position: "relative", minHeight }}>
        {rendering && !error && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--bg-primary)",
              zIndex: 1,
            }}
          >
            <Spin size="small" />
          </div>
        )}
        <div
          ref={hostRef}
          className="mermaid-block__svg-host"
          style={{
            overflow: "auto",
            minHeight,
          }}
        />
      </div>
    </div>
  );
}

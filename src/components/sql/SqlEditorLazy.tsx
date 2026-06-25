import { Suspense, lazy } from "react";
import { Spin } from "antd";
import type { SqlEditorProps } from "./SqlEditor";

// 懒加载 SqlEditor：其依赖的 monaco-editor 体积较大（数 MB），
// 用户未打开 SQL 标签时无需加载，显著减小首屏成本。
const SqlEditorInner = lazy(() =>
  import("./SqlEditor").then((m) => ({ default: m.SqlEditor }))
);

const fallback = (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      height: "100%",
      minHeight: 200,
    }}
  >
    <Spin />
  </div>
);

export function SqlEditor(props: SqlEditorProps) {
  return (
    <Suspense fallback={fallback}>
      <SqlEditorInner {...props} />
    </Suspense>
  );
}

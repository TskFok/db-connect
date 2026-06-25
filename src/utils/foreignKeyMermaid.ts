import type { ForeignKeyInfo } from "../types";

/** 生成用于 Mermaid Live / Markdown 的简单关系图源码 */
export function buildForeignKeyMermaidDiagram(fks: ForeignKeyInfo[]): string {
  if (!fks.length) {
    return "flowchart LR\n  empty[无外键关联]";
  }
  const lines: string[] = ["flowchart LR"];
  let i = 0;
  for (const fk of fks) {
    const child = `${fk.table_schema}.${fk.table_name}`;
    const parent = `${fk.referenced_table_schema}.${fk.referenced_table_name}`;
    const cols = fk.column_names.join(", ");
    const rcols = fk.referenced_column_names.join(", ");
    const cid = `c${i}`;
    const pid = `p${i}`;
    const label = `${fk.constraint_name}: ${cols} -> ${rcols}`;
    lines.push(`  ${cid}["${escapeMermaidLabel(child)}"]`);
    lines.push(`  ${pid}["${escapeMermaidLabel(parent)}"]`);
    lines.push(
      `  ${cid} -->|"${escapeMermaidLabel(label)} (${fk.direction})"| ${pid}`
    );
    i += 1;
  }
  return lines.join("\n");
}

function escapeMermaidLabel(s: string): string {
  return s.replace(/"/g, "#quot;");
}

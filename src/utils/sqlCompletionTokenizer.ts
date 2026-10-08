import type { SqlDialect } from "./sqlCompletion";
import type { SqlToken } from "./sqlCompletionTypes";

const KEYWORDS = new Set(
  "SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL CROSS OUTER ON USING AS GROUP BY HAVING ORDER LIMIT OFFSET FETCH UNION ALL DISTINCT INTERSECT EXCEPT UPDATE SET INSERT INTO VALUES DELETE WITH RECURSIVE AND OR NOT IS NULL TRUE FALSE IN LIKE ILIKE BETWEEN EXISTS CASE WHEN THEN ELSE END ASC DESC RETURNING OUTPUT TOP NATURAL LATERAL FINAL SAMPLE PREWHERE QUALIFY WINDOW OVER PARTITION MERGE ONLY TABLESAMPLE PIVOT UNPIVOT APPLY".split(
    " "
  )
);
const identifierStart = /[\p{L}\p{Nl}_]/u;
const identifierPart = /[\p{L}\p{Nl}\p{N}\p{M}_$]/u;

/** Raw text and offsets deliberately retain UTF-16 coordinates used by Monaco. */
export function tokenizeSql(sql: string, dialect: SqlDialect): SqlToken[] {
  const tokens: SqlToken[] = [];
  scanSqlTokens(sql, dialect, 0, (token) => {
    tokens.push(token);
  });
  return tokens;
}

/** Scan from a known ordinary lexical checkpoint, retaining full line context.
 * Returning false stops at the emitted token; strings/comments are consumed whole.
 */
export function scanSqlTokens(
  sql: string,
  dialect: SqlDialect,
  startOffset: number,
  onToken: (token: SqlToken) => boolean | void
): void {
  let i = startOffset;
  const push = (start: number, kind: SqlToken["kind"], quoted = false) =>
    onToken({ kind, text: sql.slice(start, i), start, end: i, quoted });
  while (i < sql.length) {
    if (/\s/.test(sql[i])) {
      i++;
      continue;
    }
    const start = i;
    const ch = sql[i];
    if (
      (sql.startsWith("--", i) &&
        (dialect !== "mysql" ||
          i + 2 === sql.length ||
          /\s/.test(sql[i + 2]))) ||
      (ch === "#" && dialect === "mysql")
    ) {
      while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") i++;
      if (push(start, "comment") === false) return;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      i += 2;
      let depth = 1;
      while (i < sql.length && depth) {
        if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else if (
          (dialect === "postgres" || dialect === "sqlserver") &&
          sql.startsWith("/*", i)
        ) {
          depth++;
          i += 2;
        } else i++;
      }
      if (push(start, "comment") === false) return;
      continue;
    }
    const dollar =
      dialect === "postgres" && ch === "$"
        ? sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0]
        : undefined;
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length);
      i = end < 0 ? sql.length : end + dollar.length;
      if (push(start, "string", true) === false) return;
      continue;
    }
    const bracket =
      ch === "[" && (dialect === "sqlserver" || dialect === "sqlite");
    const backtick =
      ch === "`" &&
      (dialect === "mysql" || dialect === "sqlite" || dialect === "clickhouse");
    if (ch === "'" || ch === '"' || bracket || backtick) {
      const closing = bracket ? "]" : ch;
      const string = ch === "'" || (ch === '"' && dialect === "mysql");
      i++;
      while (i < sql.length) {
        if (sql[i] === closing) {
          i++;
          if (sql[i] === closing) {
            i++;
            continue;
          }
          break;
        }
        if (
          sql[i] === "\\" &&
          (dialect === "mysql" ||
            dialect === "clickhouse" ||
            (dialect === "postgres" &&
              string &&
              /[eE]/.test(sql[start - 1] ?? "")))
        )
          i += Math.min(2, sql.length - i);
        else i++;
      }
      if (push(start, string ? "string" : "identifier", true) === false) return;
      continue;
    }
    if (/\d/.test(ch)) {
      i++;
      while (i < sql.length && /[\d.]/.test(sql[i])) i++;
      if (/[eE]/.test(sql[i] ?? "") && /^[eE][+-]?\d/.test(sql.slice(i))) {
        i++;
        if (/[+-]/.test(sql[i])) i++;
        while (/\d/.test(sql[i] ?? "")) i++;
      }
      if (push(start, "number") === false) return;
      continue;
    }
    const cp = String.fromCodePoint(sql.codePointAt(i)!);
    if (identifierStart.test(cp)) {
      i += cp.length;
      while (i < sql.length) {
        const next = String.fromCodePoint(sql.codePointAt(i)!);
        if (!identifierPart.test(next)) break;
        i += next.length;
      }
      const word = sql.slice(start, i).toUpperCase();
      // Only standalone batch separators are structural; GO in identifiers is not.
      const go =
        dialect === "sqlserver" &&
        word === "GO" &&
        /^[\t ]*$/.test(
          sql.slice(sql.lastIndexOf("\n", start - 1) + 1, start)
        ) &&
        /^[\t ]*(?:\r?\n|$)/.test(sql.slice(i));
      if (
        push(
          start,
          go ? "punctuation" : KEYWORDS.has(word) ? "keyword" : "identifier"
        ) === false
      )
        return;
      continue;
    }
    i++;
    if ("(),.;".includes(ch)) {
      if (push(start, "punctuation") === false) return;
    } else {
      if (
        ["<=", ">=", "<>", "!=", "||", "::", ":="].includes(
          sql.slice(start, i + 1)
        )
      )
        i++;
      if (push(start, "operator") === false) return;
    }
  }
}

export function findSqlStatement(
  tokens: SqlToken[],
  offset: number,
  textLength: number
): { start: number; end: number } {
  let start = 0;
  for (const token of tokens) {
    if (
      token.kind !== "punctuation" ||
      (token.text !== ";" && token.text.toUpperCase() !== "GO")
    )
      continue;
    if (token.end <= offset) start = token.end;
    else return { start, end: token.start };
  }
  return { start, end: textLength };
}

export function isClosedSqlIdentifier(token: SqlToken): boolean {
  if (!token.quoted) return true;
  const closing = token.text[0] === "[" ? "]" : token.text[0];
  let i = 1;
  while (i < token.text.length) {
    if (token.text[i] === closing) {
      if (token.text[i + 1] === closing) {
        i += 2;
        continue;
      }
      return i === token.text.length - 1;
    }
    i++;
  }
  return false;
}

/** Decode SQL spelling without catalog binding or PostgreSQL case folding. */
export function decodeSqlIdentifier(text: string, quoted: boolean): string {
  if (!quoted) return text;
  const closing = text[0] === "[" ? "]" : text[0];
  let value = text.slice(1);
  if (
    isClosedSqlIdentifier({
      text,
      quoted,
      kind: "identifier",
      start: 0,
      end: text.length,
    })
  )
    value = value.slice(0, -1);
  return value.split(closing + closing).join(closing);
}

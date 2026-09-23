import type { SqlDialect } from "./sqlCompletion";
import {
  resolveSqlName,
  sqlIdentifierName,
} from "./sqlCompletionMetadataIndex";
import type { ColumnSymbol, SqlClause, SqlToken } from "./sqlCompletionTypes";
import {
  decodeSqlIdentifier,
  isClosedSqlIdentifier,
  tokenizeSql,
} from "./sqlCompletionTokenizer";

export interface ParsedFromRef {
  id: string;
  kind: "table" | "cte" | "derived";
  declarationStart: number;
  name: string;
  nameQuoted: boolean;
  namespace?: string;
  namespaceQuoted?: boolean;
  alias?: string;
  aliasQuoted?: boolean;
  columnAliases?: ColumnSymbol[];
  bodyScopeId?: string;
  lateral: boolean;
}
export interface ParsedCte {
  name: string;
  quoted: boolean;
  columnAliases?: ColumnSymbol[];
  bodyScopeId: string;
  recursive: boolean;
}
export interface ParsedQueryBlock {
  id: string;
  parentId?: string;
  range: { start: number; end: number };
  kind: "statement" | "cte" | "derived" | "expression" | "lateral" | "compound";
  selectItems: SqlToken[][];
  from: ParsedFromRef[];
  ctes: ParsedCte[];
  clauses: Array<{ name: SqlClause; start: number; end: number }>;
  setBranchIds?: string[];
  joinsMergeColumns?: boolean;
  unsupported?: string;
}

const word = (token?: SqlToken): string =>
  token &&
  !token.quoted &&
  (token.kind === "keyword" || token.kind === "identifier")
    ? token.text.toUpperCase()
    : "";
const identifier = (token?: SqlToken): token is SqlToken =>
  token?.kind === "identifier" && isClosedSqlIdentifier(token);
const name = (token: SqlToken) => decodeSqlIdentifier(token.text, token.quoted);

/** Parse structure only. Neither catalog binding nor SQL execution belongs here. */
export function parseSqlQueryBlocks(
  sql: string,
  statement: { start: number; end: number },
  dialect: SqlDialect
): ParsedQueryBlock[] {
  const tokens = tokenizeSql(sql.slice(statement.start, statement.end), dialect)
    .filter((t) => t.kind !== "comment" && t.text !== ";")
    .map((t) => ({
      ...t,
      start: t.start + statement.start,
      end: t.end + statement.start,
    }));
  if (!["SELECT", "WITH"].includes(word(tokens[0]))) return [];
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  let invalid: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text === "(") {
      stack.push(i);
      if (stack.length > 32) invalid = "query nesting exceeds 32";
    } else if (tokens[i].text === ")") {
      const open = stack.pop();
      if (open === undefined) invalid = "unbalanced parentheses";
      else pairs.set(open, i);
    }
  }
  if (stack.length) invalid = "unbalanced parentheses";
  const blocks: ParsedQueryBlock[] = [];
  const topIndices = (lo: number, hi: number) => {
    const result: number[] = [];
    for (let i = lo; i < hi; i++) {
      result.push(i);
      if (tokens[i].text === "(") i = pairs.get(i) ?? hi;
    }
    return result;
  };
  const columnList = (open: number): ColumnSymbol[] | undefined => {
    const close = pairs.get(open);
    if (close === undefined) return undefined;
    const result: ColumnSymbol[] = [];
    for (let i = open + 1; i < close; i += 2) {
      if (
        !identifier(tokens[i]) ||
        (i + 1 < close && tokens[i + 1].text !== ",")
      )
        return undefined;
      result.push({ name: name(tokens[i]), quoted: tokens[i].quoted });
    }
    return result.length && (close - open) % 2 === 0 ? result : undefined;
  };
  const parse = (
    lo: number,
    hi: number,
    range: ParsedQueryBlock["range"],
    kind: ParsedQueryBlock["kind"],
    parentId?: string
  ): ParsedQueryBlock => {
    const block: ParsedQueryBlock = {
      id: `query:${range.start}:${range.end}`,
      parentId,
      range,
      kind,
      selectItems: [],
      from: [],
      ctes: [],
      clauses: [],
    };
    blocks.push(block);
    const fail = (reason: string) => {
      block.unsupported = reason;
      block.from = [];
      return block;
    };
    if (invalid) return fail(invalid);
    const owned = new Set<number>();
    const child = (open: number, childKind: ParsedQueryBlock["kind"]) => {
      owned.add(open);
      const close = pairs.get(open)!;
      return parse(
        open + 1,
        close,
        { start: tokens[open].end, end: tokens[close].start },
        childKind,
        block.id
      );
    };
    let start = lo;
    if (word(tokens[start]) === "WITH") {
      start++;
      const explicitRecursive = word(tokens[start]) === "RECURSIVE";
      const recursive = explicitRecursive || dialect === "sqlserver";
      if (explicitRecursive) start++;
      while (start < hi) {
        const cteName = tokens[start++];
        if (!identifier(cteName)) return fail("unsupported WITH declaration");
        let aliases: ColumnSymbol[] | undefined;
        if (tokens[start]?.text === "(") {
          aliases = columnList(start);
          if (!aliases) return fail("invalid CTE column list");
          start = pairs.get(start)! + 1;
        }
        if (
          word(tokens[start++]) !== "AS" ||
          tokens[start]?.text !== "(" ||
          !["SELECT", "WITH"].includes(word(tokens[start + 1]))
        )
          return fail("unsupported WITH declaration");
        const body = child(start, "cte");
        block.ctes.push({
          name: name(cteName),
          quoted: cteName.quoted,
          columnAliases: aliases,
          bodyScopeId: body.id,
          recursive,
        });
        start = pairs.get(start)! + 1;
        if (tokens[start]?.text !== ",") break;
        start++;
      }
    }
    if (word(tokens[start]) !== "SELECT")
      return fail("unsupported query statement");
    const top = topIndices(start, hi);
    const sets = top.filter((i) =>
      ["UNION", "INTERSECT", "EXCEPT"].includes(word(tokens[i]))
    );
    if (sets.length) {
      block.kind = "compound";
      block.setBranchIds = [];
      const order = top.find(
        (i) =>
          i > sets[sets.length - 1] &&
          word(tokens[i]) === "ORDER" &&
          word(tokens[i + 1]) === "BY"
      );
      const finish = order ?? hi;
      let branchStart = start;
      for (const boundary of [...sets, finish]) {
        const branchEnd = boundary < hi ? tokens[boundary].start : range.end;
        const branch = parse(
          branchStart,
          boundary,
          { start: tokens[branchStart].start, end: branchEnd },
          "statement",
          block.id
        );
        block.setBranchIds.push(branch.id);
        branchStart = boundary + 1;
        if (["ALL", "DISTINCT"].includes(word(tokens[branchStart])))
          branchStart++;
      }
      if (order !== undefined)
        block.clauses.push({
          name: "orderBy",
          start: tokens[order].start,
          end: range.end,
        });
      return block;
    }
    const unsupported = top.find(
      (i) =>
        [
          "APPLY",
          "PIVOT",
          "UNPIVOT",
          "UNNEST",
          "TABLESAMPLE",
          "QUALIFY",
          "WINDOW",
        ].includes(word(tokens[i])) ||
        (word(tokens[i]) === "DISTINCT" && word(tokens[i + 1]) === "ON") ||
        (dialect === "clickhouse" &&
          (["FINAL", "PREWHERE", "SAMPLE"].includes(word(tokens[i])) ||
            (word(tokens[i]) === "ARRAY" && word(tokens[i + 1]) === "JOIN") ||
            (word(tokens[i]) === "LIMIT" &&
              top.some((j) => j > i && word(tokens[j]) === "BY"))))
    );
    if (top.some((i) => ["NATURAL", "USING"].includes(word(tokens[i]))))
      block.joinsMergeColumns = true;
    const clauseAt = (i: number): SqlClause | undefined => {
      const current = word(tokens[i]);
      if (["SELECT", "FROM", "JOIN", "ON", "WHERE", "HAVING"].includes(current))
        return current.toLowerCase() as SqlClause;
      if (current === "GROUP" && word(tokens[i + 1]) === "BY") return "groupBy";
      if (current === "ORDER" && word(tokens[i + 1]) === "BY") return "orderBy";
      return undefined;
    };
    for (const i of top) {
      const clause = clauseAt(i);
      if (!clause) continue;
      const previous = block.clauses[block.clauses.length - 1];
      if (previous) previous.end = tokens[i].start;
      block.clauses.push({
        name: clause,
        start: tokens[i].start,
        end: range.end,
      });
    }
    const projectionEnd =
      top.find(
        (i) =>
          i > start &&
          (clauseAt(i) !== undefined ||
            ["LIMIT", "OFFSET", "FETCH"].includes(word(tokens[i])))
      ) ?? hi;
    let itemStart = start + 1;
    if (["DISTINCT", "ALL"].includes(word(tokens[itemStart]))) itemStart++;
    for (const i of [
      ...top.filter(
        (i) => i >= itemStart && i < projectionEnd && tokens[i].text === ","
      ),
      projectionEnd,
    ]) {
      block.selectItems.push(tokens.slice(itemStart, i));
      itemStart = i + 1;
    }
    if (unsupported !== undefined)
      return fail(`unsupported ${word(tokens[unsupported])}`);
    let from = false;
    for (let p = 0; p < top.length; p++) {
      const i = top[p];
      const current = word(tokens[i]);
      if (
        [
          "WHERE",
          "GROUP",
          "HAVING",
          "ORDER",
          "LIMIT",
          "OFFSET",
          "FETCH",
        ].includes(current)
      )
        from = false;
      if (
        !(
          current === "FROM" ||
          current === "JOIN" ||
          (from && tokens[i].text === ",")
        )
      )
        continue;
      from = true;
      let at = i + 1;
      const lateral = word(tokens[at]) === "LATERAL";
      if (lateral) at++;
      const first = tokens[at];
      if (!first || at >= hi) continue; // An unfinished FROM still permits table completion.
      const ref: ParsedFromRef = {
        id: `relation:${first.start}`,
        kind: "table",
        declarationStart: first.start,
        name: "",
        nameQuoted: false,
        lateral,
      };
      if (first.text === "(") {
        if (!["SELECT", "WITH"].includes(word(tokens[at + 1])))
          return fail("unsupported parenthesized FROM");
        const body = child(at, lateral ? "lateral" : "derived");
        ref.kind = "derived";
        ref.bodyScopeId = body.id;
        at = pairs.get(at)! + 1;
      } else if (identifier(first)) {
        const parts = [first];
        at++;
        while (tokens[at]?.text === "." && identifier(tokens[at + 1])) {
          parts.push(tokens[at + 1]);
          at += 2;
        }
        if (
          parts.length > 2 ||
          tokens[at]?.text === "." ||
          tokens[at]?.text === "("
        )
          return fail("unsupported relation source");
        ref.name = name(parts[parts.length - 1]);
        ref.nameQuoted = parts[parts.length - 1].quoted;
        if (parts.length === 2) {
          ref.namespace = name(parts[0]);
          ref.namespaceQuoted = parts[0].quoted;
        }
      } else return fail("invalid relation declaration");
      if (word(tokens[at]) === "AS") at++;
      if (identifier(tokens[at])) {
        ref.alias = name(tokens[at]);
        ref.aliasQuoted = tokens[at].quoted;
        at++;
      }
      if (ref.kind === "derived" && tokens[at]?.text === "(") {
        ref.columnAliases = columnList(at);
        if (!ref.columnAliases) return fail("invalid derived column list");
        at = pairs.get(at)! + 1;
      }
      if (
        dialect === "sqlserver" &&
        word(tokens[at]) === "WITH" &&
        tokens[at + 1]?.text === "("
      )
        at = pairs.get(at + 1)! + 1;
      block.from.push(ref);
      while (p + 1 < top.length && top[p + 1] < at) p++;
    }
    // Walk expression parentheses only after relation and CTE bodies have owners.
    const expressions = (begin: number, end: number) => {
      for (let i = begin; i < end; i++) {
        if (tokens[i].text !== "(") continue;
        const close = pairs.get(i)!;
        if (!owned.has(i)) {
          if (["SELECT", "WITH"].includes(word(tokens[i + 1])))
            child(i, "expression");
          else expressions(i + 1, close);
        }
        i = close;
      }
    };
    expressions(lo, hi);
    return block;
  };
  parse(0, tokens.length, statement, "statement");
  const byId = new Map(blocks.map((block) => [block.id, block]));
  for (const block of blocks) {
    for (const ref of block.from) {
      if (ref.kind !== "table" || ref.namespace !== undefined) continue;
      let current: ParsedQueryBlock | undefined = block;
      while (current) {
        if (
          resolveSqlName(
            ref.name,
            ref.nameQuoted,
            current.ctes.map((cte) =>
              sqlIdentifierName(cte.name, cte.quoted, dialect)
            ),
            dialect
          ) !== undefined
        ) {
          ref.kind = "cte";
          break;
        }
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
    }
  }
  return blocks;
}

import { quoteIdentifier, quoteSqlReference } from "./sqlCompletion";
import {
  resolveSqlName,
  sqlIdentifierName,
} from "./sqlCompletionMetadataIndex";
import type {
  CompletionCandidate,
  RelationSymbol,
  SqlCompletionContext,
  SqlMetadataIndex,
} from "./sqlCompletionTypes";

const EXPRESSION_KEYWORDS = ["NULL", "CASE", "NOT", "EXISTS"];
const SCALAR_FUNCTIONS = ["COALESCE", "NULLIF"];
const AGGREGATE_FUNCTIONS = ["COUNT", "SUM", "AVG", "MIN", "MAX"];

function keywordsFor(context: SqlCompletionContext): string[] {
  const { slot, clause, dialect } = context;
  if (slot === "continuation") {
    if (clause === "update") return ["AS", "SET"];
    if (clause === "insertInto") return ["VALUES", "SELECT"];
    if (clause === "join") return ["AS", "ON", "USING"];
    if (clause === "from" || clause === "delete") {
      return [
        "AS",
        "WHERE",
        "JOIN",
        "LEFT JOIN",
        "INNER JOIN",
        "CROSS JOIN",
        "GROUP BY",
        "ORDER BY",
        ...(dialect === "sqlserver" ? [] : ["LIMIT"]),
      ];
    }
    return ["WHERE", "GROUP BY", "HAVING", "ORDER BY"];
  }
  if (slot === "keyword") {
    if (context.operator === "NOT")
      return [
        "IN",
        "LIKE",
        "BETWEEN",
        ...(dialect === "postgres" ? ["ILIKE"] : []),
      ];
    if (context.operator === "IS" || context.operator === "IS NOT")
      return dialect === "sqlserver" ? ["NULL"] : ["NULL", "TRUE", "FALSE"];
    if (clause === "unknown")
      return ["SELECT", "INSERT INTO", "UPDATE", "DELETE FROM"];
    if (clause === "set") return ["=", "WHERE"];
    if (clause === "groupBy") return ["HAVING", "ORDER BY"];
    if (clause === "orderBy")
      return [
        "ASC",
        "DESC",
        ...(dialect === "sqlserver" ? ["OFFSET"] : ["LIMIT", "OFFSET"]),
      ];
    if (clause === "select") return ["AS", "FROM"];
    return [
      "=",
      "<>",
      "<",
      ">",
      "<=",
      ">=",
      "IN",
      "NOT IN",
      "LIKE",
      "IS NULL",
      "IS NOT NULL",
      "BETWEEN",
      "AND",
      "OR",
      ...(dialect === "postgres" ? ["ILIKE"] : []),
    ];
  }
  return clause === "select"
    ? [...EXPRESSION_KEYWORDS, "DISTINCT"]
    : EXPRESSION_KEYWORDS;
}

/** 先限定当前语法槽位和查询块，再进行名称匹配与稳定排序。 */
export function generateSqlCompletionCandidates(
  context: SqlCompletionContext,
  index: SqlMetadataIndex
): CompletionCandidate[] {
  if (context.slot === "none") return [];
  const { dialect } = context;
  const result: CompletionCandidate[] = [];
  const prefix = context.prefix.toLowerCase();
  function add(
    candidate: Omit<CompletionCandidate, "sortText">,
    priority: number,
    identity = ""
  ) {
    const name = candidate.filterText.toLowerCase();
    const match =
      !prefix || name.startsWith(prefix) ? 0 : name.includes(prefix) ? 1 : -1;
    if (match < 0) return;
    result.push({
      ...candidate,
      sortText: `${priority}:${match}:${name}:${candidate.filterText}:${identity}`,
    });
  }
  const currentNamespace = index.key.database;
  const matchesNamespace = (name: string, quoted = false) =>
    currentNamespace !== null &&
    resolveSqlName(name, quoted, [currentNamespace], dialect) !== undefined;
  // Provider 注入的默认 namespace 是 catalog 名称，而非需要折叠的 SQL token。
  const defaultMatches =
    context.defaultNamespace == null ||
    context.defaultNamespace === currentNamespace;
  if (context.slot === "table") {
    const namespaceMatches =
      context.qualifierParts.length === 0
        ? defaultMatches
        : context.qualifierParts.length === 1 &&
          matchesNamespace(
            context.qualifierParts[0],
            context.qualifierQuoted?.[0]
          );
    if (namespaceMatches) {
      for (const table of index.tablesByName.values()) {
        add(
          {
            label: table.name,
            filterText: table.name,
            insertText: quoteIdentifier(table.name, dialect),
            kind: "table",
            detail: "表 / 视图",
          },
          0
        );
      }
    }
    if (context.qualifierParts.length === 0) {
      for (const namespace of [...new Set(index.schema.databases)]) {
        add(
          {
            label: namespace,
            filterText: namespace,
            insertText: quoteIdentifier(namespace, dialect),
            kind: "relation",
            detail:
              dialect === "postgres" || dialect === "sqlserver"
                ? "schema"
                : "数据库",
          },
          1
        );
      }
    }
    return sorted(result);
  }
  if (context.slot === "continuation" || context.slot === "keyword") {
    if (context.qualifierParts.length) return [];
    for (const keyword of keywordsFor(context))
      add(
        {
          label: keyword,
          filterText: keyword,
          insertText: keyword,
          kind: "keyword",
        },
        2
      );
    return sorted(result);
  }

  let relations =
    context.scopes.find((scope) => scope.id === context.scopeId)?.relations ??
    [];
  if (context.slot === "joinCondition" && context.join) {
    const visibleIds = new Set([
      ...context.join.leftRelationIds,
      context.join.rightRelationId,
    ]);
    relations = relations.filter((relation) => visibleIds.has(relation.id));
  }
  if (context.qualifierParts.length) {
    const [first, second] = context.qualifierParts;
    const namespaceQualifier = context.qualifierParts.length === 2;
    if (
      context.qualifierParts.length > 2 ||
      (namespaceQualifier &&
        !matchesNamespace(first, context.qualifierQuoted?.[0]))
    )
      return [];
    const eligible = namespaceQualifier
      ? relations.filter(
          (relation) =>
            !relation.alias &&
            (relation.namespace
              ? matchesNamespace(relation.namespace, relation.namespaceQuoted)
              : defaultMatches)
        )
      : relations;
    const names = eligible.map((relation) =>
      sqlIdentifierName(
        relation.alias ?? relation.name,
        relation.alias ? !!relation.aliasQuoted : !!relation.nameQuoted,
        dialect
      )
    );
    const name = resolveSqlName(
      namespaceQualifier ? second : first,
      context.qualifierQuoted?.[namespaceQualifier ? 1 : 0] ?? false,
      names,
      dialect
    );
    if (name === undefined) return [];
    relations = eligible.filter((_, i) => names[i] === name);
  }
  const bound = relations.flatMap((relation) => {
    if (relation.kind !== "table") return [];
    if (
      relation.namespace
        ? !matchesNamespace(relation.namespace, relation.namespaceQuoted)
        : !defaultMatches
    )
      return [];
    const name = resolveSqlName(
      relation.name,
      !!relation.nameQuoted,
      [...index.tablesByName.keys()],
      dialect
    );
    if (name === undefined) return [];
    return (index.columnsByTable.get(name) ?? []).map((column) => ({
      relation,
      column,
    }));
  });
  const counts = new Map<string, number>();
  const collisionName = (name: string) =>
    dialect === "postgres" || dialect === "clickhouse"
      ? name
      : name.toLowerCase();
  for (const { column } of bound)
    counts.set(
      collisionName(column.name),
      (counts.get(collisionName(column.name)) ?? 0) + 1
    );
  for (const { relation, column } of bound) {
    if (
      context.slot === "columnList" &&
      context.excludedColumns.some(
        (name) =>
          resolveSqlName(
            name,
            dialect === "postgres",
            [column.name],
            dialect
          ) !== undefined
      )
    )
      continue;
    const reference = relation.alias ?? relation.name;
    const quotedReference = quoteSqlReference(
      reference,
      relation.alias ? !!relation.aliasQuoted : !!relation.nameQuoted,
      dialect
    );
    const insertText =
      context.qualifierParts.length === 0 &&
      (counts.get(collisionName(column.name)) ?? 0) > 1
        ? `${quotedReference}.${quoteIdentifier(column.name, dialect)}`
        : quoteIdentifier(column.name, dialect);
    add(
      {
        label: `${reference}.${column.name}`,
        filterText: column.name,
        insertText,
        kind: "column",
        detail: relationDetail(relation, column.type),
      },
      0,
      relation.id
    );
  }
  // 显式限定符表达的是字段引用，未知限定符不回退全库或表达式建议。
  if (context.qualifierParts.length === 0 && context.slot !== "columnList") {
    const functions = ["select", "having", "orderBy"].includes(context.clause)
      ? [...SCALAR_FUNCTIONS, ...AGGREGATE_FUNCTIONS]
      : SCALAR_FUNCTIONS;
    for (const name of functions)
      add(
        {
          label: name,
          filterText: name,
          insertText: `${name}()`,
          kind: "function",
          detail: "函数",
        },
        1
      );
    for (const name of keywordsFor(context))
      add(
        { label: name, filterText: name, insertText: name, kind: "keyword" },
        2
      );
  }
  return sorted(result);
}

function sorted(items: CompletionCandidate[]): CompletionCandidate[] {
  return items.sort((a, b) =>
    a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : 0
  );
}
function relationDetail(relation: RelationSymbol, type?: string): string {
  return `${relation.namespace ? `${relation.namespace}.` : ""}${relation.name}${relation.alias ? ` (${relation.alias})` : ""}${type ? ` · ${type}` : ""}`;
}

import { quoteIdentifier, quoteSqlReference } from "./sqlCompletion";
import {
  resolveSqlName,
  sqlIdentifierName,
} from "./sqlCompletionMetadataIndex";
import type {
  CompletionCandidate,
  ColumnSymbol,
  QueryScope,
  RelationSymbol,
  SqlCompletionContext,
  SqlMetadataIndex,
} from "./sqlCompletionTypes";

const EXPRESSION_KEYWORDS = ["NULL", "CASE", "NOT", "EXISTS"];
const SCALAR_FUNCTIONS = ["COALESCE", "NULLIF"];
const AGGREGATE_FUNCTIONS = ["COUNT", "SUM", "AVG", "MIN", "MAX"];

function identifierKey(name: string, context: SqlCompletionContext): string {
  return context.dialect === "postgres" || context.dialect === "clickhouse"
    ? name
    : name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function relationName(
  relation: RelationSymbol,
  context: SqlCompletionContext
): string {
  return sqlIdentifierName(
    relation.alias ?? relation.name,
    relation.alias ? !!relation.aliasQuoted : !!relation.nameQuoted,
    context.dialect
  );
}

/** 每条相关边单独授权父级实例；本层限定名遮蔽更外层限定名。 */
function visibleRelations(
  context: SqlCompletionContext,
  current?: QueryScope
): RelationSymbol[] {
  const result: RelationSymbol[] = [];
  const shadowed = new Set<string>();
  const visited = new Set<string>();
  let scope = current;
  let allowed: Set<string> | undefined;
  while (scope && !visited.has(scope.id)) {
    visited.add(scope.id);
    let relations = scope.relations.filter(
      (relation) => !allowed || allowed.has(relation.id)
    );
    if (scope === current && context.slot === "joinCondition" && context.join) {
      const ids = new Set([
        ...context.join.leftRelationIds,
        context.join.rightRelationId,
      ]);
      relations = relations.filter((relation) => ids.has(relation.id));
    }
    for (const relation of relations) {
      if (
        !shadowed.has(identifierKey(relationName(relation, context), context))
      )
        result.push(relation);
    }
    for (const relation of relations)
      shadowed.add(identifierKey(relationName(relation, context), context));
    if (
      !scope.canCorrelate ||
      !scope.parentId ||
      !scope.visibleParentRelationIds
    )
      break;
    allowed = new Set(scope.visibleParentRelationIds);
    scope = context.scopes.find((parent) => parent.id === scope!.parentId);
  }
  return result;
}

function aliasesAllowed(context: SqlCompletionContext): boolean {
  const { dialect, clause } = context;
  if (context.slot !== "column" || context.qualifierParts.length) return false;
  if (dialect === "clickhouse")
    return ["select", "where", "groupBy", "having", "orderBy"].includes(clause);
  if (dialect === "mysql")
    return ["groupBy", "having", "orderBy"].includes(clause);
  if (dialect === "postgres") return ["groupBy", "orderBy"].includes(clause);
  return clause === "orderBy";
}

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
  const currentScope = context.scopes.find(
    (scope) => scope.id === context.scopeId
  );
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
    const ctes =
      context.qualifierParts.length === 0 ? (currentScope?.ctes ?? []) : [];
    const cteNames = new Set(
      ctes.map((cte) =>
        identifierKey(
          sqlIdentifierName(cte.name, !!cte.nameQuoted, dialect),
          context
        )
      )
    );
    for (const cte of ctes) {
      add(
        {
          label: cte.name,
          filterText: cte.name,
          insertText: quoteSqlReference(cte.name, !!cte.nameQuoted, dialect),
          kind: "table",
          detail: "CTE",
        },
        0,
        cte.id
      );
    }
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
        if (cteNames.has(identifierKey(table.name, context))) continue;
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

  let relations = visibleRelations(context, currentScope);
  if (context.qualifierParts.length) {
    const [first, second] = context.qualifierParts;
    const namespaceQualifier = context.qualifierParts.length === 2;
    if (
      context.qualifierParts.length > 2 ||
      (namespaceQualifier &&
        !matchesNamespace(first, context.qualifierQuoted?.[0]))
    )
      return [];
    let eligible = namespaceQualifier
      ? relations.filter(
          (relation) =>
            relation.kind === "table" &&
            !relation.alias &&
            (relation.namespace
              ? matchesNamespace(relation.namespace, relation.namespaceQuoted)
              : defaultMatches)
        )
      : relations;
    if (!namespaceQualifier) {
      const aliases = eligible.filter((relation) => relation.alias);
      const aliasName = resolveSqlName(
        first,
        !!context.qualifierQuoted?.[0],
        aliases.map((relation) => relationName(relation, context)),
        dialect
      );
      // 存在别名匹配时不再把未取别名的同名物理表混入。
      if (aliasName !== undefined) eligible = aliases;
    }
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
  const referenceCounts = new Map<string, number>();
  for (const relation of relations) {
    const name = identifierKey(relationName(relation, context), context);
    referenceCounts.set(name, (referenceCounts.get(name) ?? 0) + 1);
  }
  let hasUnknownColumns = false;
  const unknownColumns = () => {
    hasUnknownColumns = true;
    return [];
  };
  const bound = relations.flatMap<{
    relation: RelationSymbol;
    column: ColumnSymbol;
  }>((relation) => {
    if (relation.outputComplete === false) return unknownColumns();
    if (relation.kind !== "table") {
      if (!relation.outputComplete || !relation.outputColumns)
        return unknownColumns();
      const names = relation.outputColumns.map((column) =>
        identifierKey(column.name, context)
      );
      const counts = new Map<string, number>();
      for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
      return relation.outputColumns
        .filter((_, i) => counts.get(names[i]) === 1)
        .map((column) => ({ relation, column }));
    }
    if (
      relation.namespace
        ? !matchesNamespace(relation.namespace, relation.namespaceQuoted)
        : !defaultMatches
    )
      return unknownColumns();
    const name = resolveSqlName(
      relation.name,
      !!relation.nameQuoted,
      [...index.tablesByName.keys()],
      dialect
    );
    if (name === undefined) return unknownColumns();
    return (index.columnsByTable.get(name) ?? []).map((column) => ({
      relation,
      column,
    }));
  });
  const counts = new Map<string, number>();
  const collisionName = (name: string) => identifierKey(name, context);
  for (const { column } of bound)
    counts.set(
      collisionName(column.name),
      (counts.get(collisionName(column.name)) ?? 0) + 1
    );
  for (const { relation, column } of bound) {
    // 关系限定名本身必须唯一，否则加表名也无法解除歧义。
    if (
      referenceCounts.get(
        identifierKey(relationName(relation, context), context)
      ) !== 1
    )
      continue;
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
    // 输出列已经是投影推导后的语义名，catalog 大小写不能再次折叠。
    const quotedColumn = quoteIdentifier(column.name, dialect);
    const insertText =
      context.qualifierParts.length === 0 &&
      (hasUnknownColumns ||
        relation.kind !== "table" ||
        (counts.get(collisionName(column.name)) ?? 0) > 1)
        ? `${quotedReference}.${quotedColumn}`
        : quotedColumn;
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
  if (currentScope && aliasesAllowed(context)) {
    const names = currentScope.projections.map((column) =>
      collisionName(column.name)
    );
    const occurrences = new Map<string, number>();
    for (const name of names)
      occurrences.set(name, (occurrences.get(name) ?? 0) + 1);
    for (const [i, column] of currentScope.projections.entries()) {
      // 同名输入列优先；重复输出名和无法确认的别名不产生裸引用。
      if (counts.has(names[i]) || occurrences.get(names[i]) !== 1) continue;
      add(
        {
          label: column.name,
          filterText: column.name,
          insertText: quoteIdentifier(column.name, dialect),
          kind: "column",
          detail: "投影别名",
        },
        0,
        `${currentScope.id}:projection:${i}`
      );
    }
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

import type { SqlCompletionForeignKey } from "../types";
import { quoteIdentifier, quoteSqlReference } from "./sqlCompletion";
import type { SqlDialect } from "./sqlCompletion";
import type {
  CompletionCandidate,
  RelationSymbol,
  SqlCompletionContext,
} from "./sqlCompletionTypes";

type Table = { namespace: string; name: string };
const key = (table: Table) => JSON.stringify([table.namespace, table.name]);
const folded = (name: string) =>
  name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const semantic = (name: string, quoted: boolean, dialect: SqlDialect) =>
  dialect === "postgres" && !quoted ? folded(name) : name;

/** Unknown server case settings require a unique folded match, even if one spelling is exact. */
function uniqueName(
  name: string,
  quoted: boolean,
  catalog: string[],
  dialect: SqlDialect
): string | null {
  const target = semantic(name, quoted, dialect);
  const matches = catalog.filter((item) =>
    dialect === "postgres" ? item === target : folded(item) === folded(target)
  );
  return matches.length === 1 ? matches[0] : null;
}

function resolveTable(
  relation: RelationSymbol,
  tables: Table[],
  context: SqlCompletionContext
): Table | null {
  const namespaces = [...new Set(tables.map((table) => table.namespace))];
  const requestedNamespace = relation.namespace ?? context.defaultNamespace;
  const namespace =
    requestedNamespace == null
      ? null
      : uniqueName(
          requestedNamespace,
          relation.namespace === undefined || !!relation.namespaceQuoted,
          namespaces,
          context.dialect
        );
  if (requestedNamespace != null && namespace === null) return null;
  const eligible =
    namespace === null
      ? tables
      : tables.filter((table) => table.namespace === namespace);
  const tableName = uniqueName(
    relation.name,
    !!relation.nameQuoted,
    [...new Set(eligible.map((table) => table.name))],
    context.dialect
  );
  if (tableName === null) return null;
  const matches = eligible.filter((table) => table.name === tableName);
  return matches.length === 1 ? matches[0] : null;
}

function qualifier(relation: RelationSymbol, dialect: SqlDialect): string {
  return quoteSqlReference(
    relation.alias ?? relation.name,
    relation.alias === undefined
      ? !!relation.nameQuoted
      : !!relation.aliasQuoted,
    dialect
  );
}

function validForeignKey(fk: SqlCompletionForeignKey): boolean {
  return (
    !!fk.id &&
    !!fk.tableNamespace &&
    !!fk.tableName &&
    !!fk.referencedNamespace &&
    !!fk.referencedTable &&
    fk.columns.length > 0 &&
    fk.columns.length === fk.referencedColumns.length &&
    fk.columns.every(Boolean) &&
    fk.referencedColumns.every(Boolean)
  );
}

/** Match only declared catalog relationships in the current query scope. */
export function buildJoinCandidates(
  context: SqlCompletionContext,
  foreignKeys: SqlCompletionForeignKey[]
): CompletionCandidate[] {
  if (
    context.slot !== "joinCondition" ||
    context.confidence !== "high" ||
    context.dialect === "clickhouse" ||
    !context.join ||
    !(["empty", "prefix"] as const).some(
      (state) => state === context.join!.conditionState
    )
  )
    return [];
  const scope = context.scopes.find((item) => item.id === context.scopeId);
  if (!scope) return [];
  const right = scope.relations.find(
    (relation) => relation.id === context.join!.rightRelationId
  );
  const left = context.join.leftRelationIds.map((id) =>
    scope.relations.find((relation) => relation.id === id)
  );
  if (!right || right.kind !== "table" || left.some((relation) => !relation))
    return [];

  // A reused constraint ID with conflicting metadata cannot safely identify a relationship.
  const signatures = new Map<string, string>();
  const ambiguousIds = new Set<string>();
  for (const fk of foreignKeys) {
    if (!validForeignKey(fk)) continue;
    const signature = JSON.stringify([
      fk.constraintName,
      fk.tableNamespace,
      fk.tableName,
      fk.columns,
      fk.referencedNamespace,
      fk.referencedTable,
      fk.referencedColumns,
    ]);
    if (signatures.has(fk.id) && signatures.get(fk.id) !== signature)
      ambiguousIds.add(fk.id);
    signatures.set(fk.id, signature);
  }
  const valid = foreignKeys.filter(
    (fk) => validForeignKey(fk) && !ambiguousIds.has(fk.id)
  );
  const tableMap = new Map<string, Table>();
  for (const fk of valid) {
    const child = { namespace: fk.tableNamespace, name: fk.tableName };
    const parent = {
      namespace: fk.referencedNamespace,
      name: fk.referencedTable,
    };
    tableMap.set(key(child), child);
    tableMap.set(key(parent), parent);
  }
  const tables = [...tableMap.values()];
  const rightTable = resolveTable(right, tables, context);
  if (!rightTable) return [];
  const seen = new Set<string>();
  const candidates: CompletionCandidate[] = [];
  for (const leftRelation of left as RelationSymbol[]) {
    if (leftRelation.kind !== "table") continue;
    if (leftRelation.id === right.id) continue;
    const leftTable = resolveTable(leftRelation, tables, context);
    if (!leftTable) continue;
    const leftQualifier = qualifier(leftRelation, context.dialect);
    const rightQualifier = qualifier(right, context.dialect);
    if (leftQualifier === rightQualifier) continue;
    for (const fk of valid) {
      const childTable = key({
        namespace: fk.tableNamespace,
        name: fk.tableName,
      });
      const parentTable = key({
        namespace: fk.referencedNamespace,
        name: fk.referencedTable,
      });
      const assignments: Array<{
        child: RelationSymbol;
        parent: RelationSymbol;
      }> = [];
      if (childTable === key(leftTable) && parentTable === key(rightTable))
        assignments.push({ child: leftRelation, parent: right });
      if (childTable === key(rightTable) && parentTable === key(leftTable))
        assignments.push({ child: right, parent: leftRelation });
      for (const assignment of assignments) {
        const identity = JSON.stringify([
          fk.id,
          assignment.child.id,
          assignment.parent.id,
        ]);
        if (seen.has(identity)) continue;
        seen.add(identity);
        const leftIsChild = assignment.child.id === leftRelation.id;
        const pairs = fk.columns.map((column, index) => {
          const childColumn = `${qualifier(assignment.child, context.dialect)}.${quoteIdentifier(column, context.dialect)}`;
          const parentColumn = `${qualifier(assignment.parent, context.dialect)}.${quoteIdentifier(fk.referencedColumns[index], context.dialect)}`;
          return leftIsChild
            ? `${childColumn} = ${parentColumn}`
            : `${parentColumn} = ${childColumn}`;
        });
        const insertText =
          pairs.length === 1 ? pairs[0] : `(${pairs.join(" AND ")})`;
        const columnPairs = fk.columns
          .map(
            (column, index) =>
              `${fk.tableNamespace}.${fk.tableName}.${column} → ${fk.referencedNamespace}.${fk.referencedTable}.${fk.referencedColumns[index]}`
          )
          .join(", ");
        candidates.push({
          label: `${fk.constraintName}: ${insertText}`,
          filterText: `${insertText} ${fk.constraintName}`,
          insertText,
          detail: `${fk.constraintName} · 子表 ${qualifier(assignment.child, context.dialect)} → 父表 ${qualifier(assignment.parent, context.dialect)} · ${columnPairs}`,
          sortText: `00:${identity}`,
          kind: "relation",
        });
      }
    }
  }
  return candidates.sort((a, b) => a.sortText.localeCompare(b.sortText));
}

import type { SqlDialect, SqlSchema } from "./sqlCompletion";

export type SqlClause =
  | "select"
  | "from"
  | "join"
  | "on"
  | "where"
  | "groupBy"
  | "having"
  | "orderBy"
  | "update"
  | "set"
  | "insertInto"
  | "insertColumns"
  | "values"
  | "delete"
  | "unknown";
export interface SqlToken {
  kind:
    | "keyword"
    | "identifier"
    | "string"
    | "comment"
    | "number"
    | "punctuation"
    | "operator";
  text: string;
  start: number;
  end: number;
  quoted: boolean;
}
export interface ColumnSymbol {
  name: string;
  type?: string;
  quoted?: boolean;
  source?: { relationId: string; column: string };
}
export interface RelationSymbol {
  id: string;
  kind: "table" | "cte" | "derived";
  name: string;
  alias?: string;
  namespace?: string;
  nameQuoted?: boolean;
  namespaceQuoted?: boolean;
  aliasQuoted?: boolean;
  outputColumns?: ColumnSymbol[];
  outputComplete?: boolean;
}
export interface QueryScope {
  id: string;
  parentId?: string;
  relations: RelationSymbol[];
  projections: ColumnSymbol[];
  canCorrelate: boolean;
  range?: { start: number; end: number };
  ctes?: RelationSymbol[];
  projectionComplete?: boolean;
  visibleParentRelationIds?: string[];
}
export interface SqlCompletionContext {
  dialect: SqlDialect;
  defaultNamespace?: string | null;
  statement: { start: number; end: number };
  scopeId: string;
  clause: SqlClause;
  slot:
    | "table"
    | "column"
    | "continuation"
    | "joinCondition"
    | "columnList"
    | "keyword"
    | "none";
  prefix: string;
  qualifierParts: string[];
  qualifierQuoted?: boolean[];
  edit: { start: number; end: number };
  scopes: QueryScope[];
  confidence: "high" | "partial" | "unknown";
  join?: {
    leftRelationIds: string[];
    rightRelationId: string;
    conditionState: "empty" | "prefix" | "expression";
  };
  excludedColumns: string[];
  operator?: "NOT" | "IS" | "IS NOT";
}
export interface CompletionCandidate {
  label: string;
  filterText: string;
  insertText: string;
  detail?: string;
  sortText: string;
  kind: "table" | "column" | "keyword" | "function" | "relation";
  documentation?: string;
}
export interface SqlCompletionCacheKey {
  connId: string;
  database: string | null;
  dialect: SqlDialect;
  connectionRevision: number;
}
export interface SqlMetadataIndex {
  key: SqlCompletionCacheKey;
  schema: SqlSchema;
  tablesByName: Map<string, { name: string }>;
  columnsByTable: Map<string, SqlSchema["columns"]>;
}

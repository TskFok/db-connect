import type { SqlDialect } from "./sqlCompletion";
import { analyzeSqlCompletion } from "./sqlCompletionContext";
import {
  resolveSqlName,
  sqlIdentifierName,
} from "./sqlCompletionMetadataIndex";
import {
  combineSqlSetProjection,
  inferSqlProjection,
} from "./sqlCompletionProjection";
import type { ProjectionInference } from "./sqlCompletionProjection";
import { parseSqlQueryBlocks } from "./sqlCompletionScopeParser";
import type {
  ParsedCte,
  ParsedFromRef,
  ParsedQueryBlock,
} from "./sqlCompletionScopeParser";
import type {
  ColumnSymbol,
  QueryScope,
  RelationSymbol,
  SqlCompletionContext,
  SqlMetadataIndex,
} from "./sqlCompletionTypes";

interface CteDefinition {
  declaration: ParsedCte;
  symbol: RelationSymbol;
}
const unknownProjection = (): ProjectionInference => ({
  columns: [],
  complete: false,
});

/** SQL 文本和当前批量索引的纯计算：既不请求元数据，也不执行 SQL。 */
export function resolveSqlCompletionScopes(input: {
  sql: string;
  offset: number;
  context: SqlCompletionContext;
  index: SqlMetadataIndex;
}): SqlCompletionContext {
  const { sql, offset, context, index } = input;
  const result: SqlCompletionContext = {
    ...context,
    statement: { ...context.statement },
    edit: { ...context.edit },
    qualifierParts: [...context.qualifierParts],
    qualifierQuoted: context.qualifierQuoted && [...context.qualifierQuoted],
    excludedColumns: [...context.excludedColumns],
    scopes: context.scopes.map((scope) => ({
      ...scope,
      relations: [...scope.relations],
      projections: [...scope.projections],
    })),
  };
  try {
    const blocks = parseSqlQueryBlocks(sql, context.statement, context.dialect);
    // UPDATE/INSERT/DELETE 仍沿用一期目标列和赋值槽位分析。
    if (!blocks.length) return result;
    const dialect = context.dialect;
    const byId = new Map(blocks.map((block) => [block.id, block]));
    const scopes = new Map<string, QueryScope>();
    const definitions = new Map<string, CteDefinition[]>();
    for (const block of blocks) {
      scopes.set(block.id, {
        id: block.id,
        parentId: block.parentId,
        range: { ...block.range },
        relations: [],
        projections: [],
        projectionComplete: false,
        ctes: [],
        canCorrelate: false,
        visibleParentRelationIds: [],
      });
      definitions.set(
        block.id,
        block.ctes.map((declaration) => ({
          declaration,
          symbol: {
            id: `cte:${declaration.bodyScopeId}`,
            kind: "cte",
            name: declaration.name,
            nameQuoted: declaration.quoted,
            outputComplete: false,
          },
        }))
      );
    }
    const semantic = (name: string, quoted = false) =>
      sqlIdentifierName(name, quoted, dialect);
    const sameName = (a: RelationSymbol, b: RelationSymbol) =>
      resolveSqlName(
        semantic(a.name, a.nameQuoted),
        true,
        [semantic(b.name, b.nameQuoted)],
        dialect
      ) !== undefined;
    const overlay = (outer: CteDefinition[], inner: CteDefinition[]) => [
      ...outer.filter((a) => !inner.some((b) => sameName(a.symbol, b.symbol))),
      ...inner,
    ];
    const environments = new Map<string, CteDefinition[]>();
    const inheritedEnvironments = new Map<string, CteDefinition[]>();
    function environment(
      block: ParsedQueryBlock,
      visiting = new Set<string>()
    ): CteDefinition[] {
      const cached = environments.get(block.id);
      if (cached) return cached;
      if (visiting.has(block.id) || visiting.size > 32) return [];
      visiting.add(block.id);
      const parent = block.parentId ? byId.get(block.parentId) : undefined;
      let inherited: CteDefinition[] = [];
      if (parent) {
        inherited = environment(parent, visiting);
        const siblings = definitions.get(parent.id)!;
        const ownIndex = siblings.findIndex(
          (c) => c.declaration.bodyScopeId === block.id
        );
        if (ownIndex >= 0) {
          // 在 CTE 本体内只继承父环境及之前的 CTE；递归声明额外允许自身。
          const outer = inheritedEnvironments.get(parent.id) ?? [];
          const preceding = siblings.slice(
            0,
            ownIndex + (siblings[ownIndex].declaration.recursive ? 1 : 0)
          );
          inherited = overlay(outer, preceding);
        }
      }
      inheritedEnvironments.set(block.id, inherited);
      const visible = overlay(inherited, definitions.get(block.id)!);
      environments.set(block.id, visible);
      return visible;
    }
    for (const block of blocks) environment(block);

    for (const block of blocks) {
      const scope = scopes.get(block.id)!;
      const parent = block.parentId ? byId.get(block.parentId) : undefined;
      if (!parent || block.unsupported || parent.unsupported) continue;
      if (
        parent.kind === "compound" &&
        parent.setBranchIds?.includes(block.id)
      ) {
        // 集合分支透过无 FROM 的 compound 父块，下一跳继续检查真正父块权限。
        scope.canCorrelate = true;
        continue;
      }
      if (block.kind === "expression") {
        const clause = clauseAt(parent, block.range.start);
        if (["select", "where", "having", "on"].includes(clause?.name ?? "")) {
          scope.canCorrelate = true;
          scope.visibleParentRelationIds = parent.from
            .filter(
              (ref) =>
                clause?.name !== "on" || ref.declarationStart < clause.start
            )
            .map((ref) => ref.id);
        }
      } else if (block.kind === "lateral" && dialect === "postgres") {
        const declaration = parent.from.find(
          (ref) => ref.bodyScopeId === block.id
        );
        if (declaration) {
          scope.canCorrelate = true;
          scope.visibleParentRelationIds = parent.from
            .filter(
              (ref) => ref.declarationStart < declaration.declarationStart
            )
            .map((ref) => ref.id);
        }
      } else if (block.kind === "compound") {
        // 复合查询仍按它在父块中的位置决定相关性，bodyScopeId 标识派生表/CTE。
        const cte = parent.ctes.some((c) => c.bodyScopeId === block.id);
        const declaration = parent.from.find(
          (ref) => ref.bodyScopeId === block.id
        );
        const clause = clauseAt(parent, block.range.start);
        if (!cte && declaration?.lateral && dialect === "postgres") {
          scope.canCorrelate = true;
          scope.visibleParentRelationIds = parent.from
            .filter(
              (ref) => ref.declarationStart < declaration.declarationStart
            )
            .map((ref) => ref.id);
        } else if (
          !cte &&
          !declaration &&
          ["select", "where", "having", "on"].includes(clause?.name ?? "")
        ) {
          scope.canCorrelate = true;
          scope.visibleParentRelationIds = parent.from
            .filter(
              (ref) =>
                clause?.name !== "on" || ref.declarationStart < clause.start
            )
            .map((ref) => ref.id);
        }
      }
    }

    const projections = new Map<string, ProjectionInference>();
    const cteOutputs = new Map<string, ProjectionInference>();
    const tableNames = [...index.tablesByName.keys()];
    function physical(ref: ParsedFromRef): ColumnSymbol[] | undefined {
      if (
        context.defaultNamespace != null &&
        context.defaultNamespace !== index.key.database
      )
        return undefined;
      if (
        ref.namespace &&
        (context.defaultNamespace == null ||
          resolveSqlName(
            ref.namespace,
            !!ref.namespaceQuoted,
            [context.defaultNamespace],
            dialect
          ) === undefined)
      )
        return undefined;
      const table = resolveSqlName(
        ref.name,
        ref.nameQuoted,
        tableNames,
        dialect
      );
      if (table === undefined) return undefined;
      return (index.columnsByTable.get(table) ?? []).map((column) => ({
        name: column.name,
        type: column.type,
        source: { relationId: ref.id, column: column.name },
      }));
    }
    function sourcesKnown(
      block: ParsedQueryBlock | undefined,
      recursiveId?: string
    ): boolean {
      if (!block || block.unsupported) return false;
      if (block.setBranchIds)
        return block.setBranchIds.every((id) =>
          sourcesKnown(byId.get(id), recursiveId)
        );
      return block.from.every((ref) => {
        const relation = scopes
          .get(block.id)
          ?.relations.find((item) => item.id === ref.id);
        if (relation?.outputComplete) return true;
        if (!recursiveId || relation?.kind !== "cte") return false;
        const visible = environments.get(block.id) ?? [];
        const name = resolveSqlName(
          ref.name,
          ref.nameQuoted,
          visible.map((c) => semantic(c.symbol.name, c.symbol.nameQuoted)),
          dialect
        );
        return (
          visible.find(
            (c) => semantic(c.symbol.name, c.symbol.nameQuoted) === name
          )?.symbol.id === recursiveId
        );
      });
    }
    function binding(
      block: ParsedQueryBlock,
      ref: ParsedFromRef
    ): RelationSymbol {
      const relation: RelationSymbol = {
        id: ref.id,
        kind: ref.bodyScopeId ? "derived" : "table",
        name: ref.name,
        nameQuoted: ref.nameQuoted,
        namespace: ref.namespace,
        namespaceQuoted: ref.namespaceQuoted,
        alias: ref.alias,
        aliasQuoted: ref.aliasQuoted,
        outputComplete: false,
      };
      let output: ProjectionInference | undefined;
      if (ref.bodyScopeId) {
        const body = byId.get(ref.bodyScopeId);
        output = applyColumnAliases(
          projections.get(ref.bodyScopeId) ?? unknownProjection(),
          ref.columnAliases,
          body,
          byId,
          projections,
          dialect
        );
        if (output.complete && !sourcesKnown(body))
          output = { ...output, complete: false };
        relation.kind = "derived";
      } else if (!ref.namespace) {
        const visible = environments.get(block.id)!;
        const name = resolveSqlName(
          ref.name,
          ref.nameQuoted,
          visible.map((c) => semantic(c.symbol.name, c.symbol.nameQuoted)),
          dialect
        );
        const cte =
          name === undefined
            ? undefined
            : visible.find(
                (c) => semantic(c.symbol.name, c.symbol.nameQuoted) === name
              );
        if (cte) {
          relation.kind = "cte";
          output = cteOutputs.get(cte.symbol.id) ?? unknownProjection();
        }
      }
      if (!output && relation.kind === "table") {
        const columns = physical(ref);
        if (columns !== undefined) output = { columns, complete: true };
      }
      if (output) {
        relation.outputColumns = output.columns.map((column) => ({
          ...column,
        }));
        relation.outputComplete = output.complete;
      }
      return relation;
    }
    // 硬上限防止递归或互相依赖占用编辑器线程；未收敛输出始终保持不完整。
    for (let round = 0; round < blocks.length + 1; round++) {
      const previous = JSON.stringify([...projections, ...cteOutputs]);
      for (const block of [...blocks].reverse()) {
        const scope = scopes.get(block.id)!;
        scope.relations = block.from.map((ref) => binding(block, ref));
        const visible = visibleParentRelations(scope, scopes);
        const localNames = new Set(
          scope.relations.map((r) =>
            semantic(r.alias ?? r.name, r.alias ? r.aliasQuoted : r.nameQuoted)
          )
        );
        const parents = visible.filter(
          (r) =>
            !localNames.has(
              semantic(
                r.alias ?? r.name,
                r.alias ? r.aliasQuoted : r.nameQuoted
              )
            )
        );
        const byRelation = new Map(
          [...parents, ...scope.relations].map((relation) => [
            relation.id,
            relation,
          ])
        );
        // 星号只展开当前 FROM；普通列引用可以绑定已获准的相关关系。
        const hasStar = block.selectItems.some((item) =>
          item.some((t) => t.text === "*")
        );
        const projectionBlock = hasStar
          ? block
          : {
              ...block,
              from: [
                ...block.from,
                ...parents.map((relation) => ({
                  ...relation,
                  nameQuoted: !!relation.nameQuoted,
                  declarationStart: 0,
                  lateral: false,
                })),
              ],
            };
        const output = block.setBranchIds
          ? combineSqlSetProjection(
              block.setBranchIds.map(
                (id) => projections.get(id) ?? unknownProjection()
              )
            )
          : inferSqlProjection(
              projectionBlock,
              (id) => {
                const relation = byRelation.get(id);
                return relation?.outputComplete
                  ? relation.outputColumns
                  : undefined;
              },
              dialect
            );
        if (output.complete && !sourcesKnown(block)) output.complete = false;
        projections.set(block.id, output);
        const simpleClickHouse =
          dialect !== "clickhouse" ||
          output.complete ||
          (!block.setBranchIds &&
            !block.unsupported &&
            inferSqlProjection(
              {
                ...projectionBlock,
                selectItems: block.selectItems.filter(
                  (item) => item.length > 0
                ),
              },
              (id) => {
                const relation = byRelation.get(id);
                return relation?.outputComplete
                  ? relation.outputColumns
                  : undefined;
              },
              dialect
            ).complete);
        scope.projections = simpleClickHouse ? output.columns : [];
        scope.projectionComplete = output.complete;
      }
      for (const entries of definitions.values()) {
        for (const entry of entries) {
          const body = byId.get(entry.declaration.bodyScopeId);
          let output =
            projections.get(entry.declaration.bodyScopeId) ??
            unknownProjection();
          if (entry.declaration.recursive && body?.setBranchIds?.length) {
            const anchor =
              projections.get(body.setBranchIds[0]) ?? unknownProjection();
            const count = projectionArity(body, byId, projections);
            // 递归项名称由锚点决定；只接受所有分支个数一致的有界形态。
            if (anchor.complete && count === anchor.columns.length)
              output = anchor;
          }
          output = applyColumnAliases(
            output,
            entry.declaration.columnAliases,
            body,
            byId,
            projections,
            dialect
          );
          const anchorBlock = body?.setBranchIds?.[0]
            ? byId.get(body.setBranchIds[0])
            : undefined;
          const recursiveId =
            entry.declaration.recursive && sourcesKnown(anchorBlock)
              ? entry.symbol.id
              : undefined;
          if (output.complete && !sourcesKnown(body, recursiveId))
            output = { ...output, complete: false };
          cteOutputs.set(entry.symbol.id, output);
          entry.symbol.outputColumns = output.columns;
          entry.symbol.outputComplete = output.complete;
        }
      }
      if (JSON.stringify([...projections, ...cteOutputs]) === previous) break;
    }
    // 最后一轮 CTE 更新后同步 FROM 实例，避免留下前一轮的完整性标记。
    for (const block of blocks) {
      const scope = scopes.get(block.id)!;
      scope.relations = block.from.map((ref) => binding(block, ref));
      scope.ctes = environments.get(block.id)!.map((c) => ({ ...c.symbol }));
    }
    result.scopes = blocks.map((block) => scopes.get(block.id)!);
    const active =
      blocks
        .filter(
          (block) => offset >= block.range.start && offset <= block.range.end
        )
        .sort(
          (a, b) =>
            a.range.end - a.range.start - (b.range.end - b.range.start) ||
            b.range.start - a.range.start
        )[0] ?? blocks[0];
    result.scopeId = active.id;
    result.confidence =
      blocks.some((block) => block.unsupported) ||
      result.scopes.some(
        (scope) =>
          !scope.projectionComplete ||
          scope.relations.some((relation) => !relation.outputComplete)
      )
        ? "partial"
        : "high";
    // 一期负责词法替换区间；只重新计算当前查询块内的槽位和子句。
    if (context.slot !== "none") {
      const local = analyzeSqlCompletion({
        sql: sql.slice(active.range.start, active.range.end),
        offset: offset - active.range.start,
        dialect,
      });
      result.clause = local.clause;
      result.slot = local.slot;
      result.operator = local.operator;
      if (active.kind === "compound") {
        const clause = clauseAt(active, offset);
        result.clause = clause?.name ?? "unknown";
        if (result.clause !== "orderBy") result.slot = "keyword";
      }
    }
    result.join = undefined;
    if (result.clause === "on") {
      const clause = clauseAt(active, offset);
      const introduced = active.from.filter(
        (ref) => ref.declarationStart < (clause?.start ?? offset)
      );
      if (introduced.length > 1)
        result.join = {
          leftRelationIds: introduced.slice(0, -1).map((ref) => ref.id),
          rightRelationId: introduced[introduced.length - 1].id,
        };
    }
    return result;
  } catch {
    // 不回退到一期可能跨查询块的关系集合。
    return {
      ...result,
      confidence: "unknown",
      join: undefined,
      scopes: [
        {
          id: context.scopeId,
          relations: [],
          projections: [],
          canCorrelate: false,
          visibleParentRelationIds: [],
        },
      ],
    };
  }
}

function clauseAt(block: ParsedQueryBlock, offset: number) {
  return [...block.clauses]
    .reverse()
    .find((clause) => clause.start <= offset && offset <= clause.end);
}

function visibleParentRelations(
  scope: QueryScope,
  scopes: Map<string, QueryScope>
): RelationSymbol[] {
  const visible: RelationSymbol[] = [];
  const visited = new Set<string>();
  let child: QueryScope | undefined = scope;
  while (child?.canCorrelate && child.parentId && !visited.has(child.id)) {
    visited.add(child.id);
    const parent: QueryScope | undefined = scopes.get(child.parentId);
    const allowed = new Set(child.visibleParentRelationIds ?? []);
    visible.push(
      ...(parent?.relations.filter((relation) => allowed.has(relation.id)) ??
        [])
    );
    child = parent;
  }
  return visible;
}

/** 显式列表可以命名无别名表达式，但不能替未知星号或不支持语法猜列数。 */
function projectionArity(
  block: ParsedQueryBlock | undefined,
  blocks: Map<string, ParsedQueryBlock>,
  projections: Map<string, ProjectionInference>
): number | undefined {
  if (!block || block.unsupported) return undefined;
  const known = projections.get(block.id);
  if (known?.complete) return known.columns.length;
  if (block.setBranchIds) {
    const counts = block.setBranchIds.map((id) =>
      projectionArity(blocks.get(id), blocks, projections)
    );
    return counts.length &&
      counts[0] !== undefined &&
      counts.every((count) => count === counts[0])
      ? counts[0]
      : undefined;
  }
  if (
    !block.selectItems.length ||
    block.selectItems.some((item) => {
      if (!item.length) return true;
      let depth = 0;
      return item.some((token) => {
        if (token.text === "(") depth++;
        if (token.text === ")") depth--;
        return (
          (token.text === "*" && depth === 0) ||
          (!token.quoted &&
            [
              "COLUMNS",
              "APPLY",
              "REPLACE",
              "EXCEPT",
              "DISTINCT",
              "OVER",
            ].includes(token.text.toUpperCase()))
        );
      });
    })
  )
    return undefined;
  return block.selectItems.length;
}

function applyColumnAliases(
  output: ProjectionInference,
  aliases: ColumnSymbol[] | undefined,
  block: ParsedQueryBlock | undefined,
  blocks: Map<string, ParsedQueryBlock>,
  projections: Map<string, ProjectionInference>,
  dialect: SqlDialect
): ProjectionInference {
  if (!aliases) return output;
  const count = projectionArity(block, blocks, projections);
  return {
    columns: aliases.map((column, i) => ({
      ...column,
      name: sqlIdentifierName(column.name, !!column.quoted, dialect),
      source: output.columns[i]?.source,
    })),
    complete: count !== undefined && count === aliases.length,
  };
}

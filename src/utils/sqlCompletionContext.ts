import type { SqlDialect } from "./sqlCompletion";
import type {
  QueryScope,
  RelationSymbol,
  SqlClause,
  SqlCompletionContext,
  SqlToken,
} from "./sqlCompletionTypes";
import {
  decodeSqlIdentifier,
  findSqlStatement,
  isClosedSqlIdentifier,
  tokenizeSql,
} from "./sqlCompletionTokenizer";

type Block = {
  scope: QueryScope;
  start: number;
  end: number;
  depth: number;
  tokens: SqlToken[];
};
type Declaration = {
  relation: RelationSymbol;
  start: number;
  end: number;
  listOpen?: number;
  listClose?: number;
};
const word = (t?: SqlToken) =>
  t?.kind === "keyword" ? t.text.toUpperCase() : "";
const identifier = (t?: SqlToken): t is SqlToken => t?.kind === "identifier";
const name = (t: SqlToken) => decodeSqlIdentifier(t.text, t.quoted);
const semanticName = (t: SqlToken, dialect: SqlDialect) =>
  dialect === "postgres" && !t.quoted
    ? name(t).replace(/[A-Z]/g, (c) => c.toLowerCase())
    : name(t);

/** A deliberately bounded parser: unknown relation outputs never become physical tables. */
export function analyzeSqlCompletion(input: {
  sql: string;
  offset: number;
  dialect: SqlDialect;
}): SqlCompletionContext {
  const { sql, dialect } = input;
  const offset = Math.max(0, Math.min(input.offset, sql.length));
  const all = tokenizeSql(sql, dialect);
  const statement = findSqlStatement(all, offset, sql.length);
  const tokens = all.filter(
    (t) =>
      t.start >= statement.start &&
      t.end <= statement.end &&
      t.kind !== "comment"
  );
  const context: SqlCompletionContext = {
    dialect,
    statement,
    scopeId: `scope:${statement.start}`,
    clause: "unknown",
    slot: "keyword",
    prefix: "",
    qualifierParts: [],
    qualifierQuoted: [],
    edit: { start: offset, end: offset },
    scopes: [],
    confidence: "high",
    excludedColumns: [],
  };
  const depths = new Map<SqlToken, number>();
  const matching = new Map<number, number>();
  const opens: SqlToken[] = [];
  for (const token of tokens) {
    if (token.text === ")") {
      const opening = opens.pop();
      if (opening) matching.set(opening.start, token.start);
      depths.set(token, opens.length);
    } else {
      depths.set(token, opens.length);
      if (token.text === "(") opens.push(token);
    }
  }
  const root: Block = {
    scope: {
      id: context.scopeId,
      relations: [],
      projections: [],
      canCorrelate: false,
    },
    start: statement.start,
    end: statement.end,
    depth: 0,
    tokens: [],
  };
  const blocks: Block[] = [root];
  const parenStack: SqlToken[] = [];
  for (const token of tokens) {
    if (token.text === "(") parenStack.push(token);
    if (token.text === ")") parenStack.pop();
    if (!["SELECT", "WITH"].includes(word(token)) || !parenStack.length)
      continue;
    const opening = parenStack[parenStack.length - 1];
    if (blocks.some((b) => b.start === opening.end)) continue;
    const parent = [...blocks]
      .reverse()
      .find((b) => token.start >= b.start && token.start <= b.end)!;
    blocks.push({
      scope: {
        id: `scope:${token.start}`,
        parentId: parent.scope.id,
        relations: [],
        projections: [],
        canCorrelate: false,
      },
      start: opening.end,
      end: matching.get(opening.start) ?? statement.end,
      depth: depths.get(token)!,
      tokens: [],
    });
  }
  // INSERT's target and SELECT source have separate visibility, even without parentheses.
  for (const block of [...blocks]) {
    const top = tokens.filter(
      (t) =>
        t.start >= block.start &&
        t.start < block.end &&
        depths.get(t) === block.depth
    );
    const insertIndex = top.findIndex((t) => word(t) === "INSERT");
    const source =
      insertIndex < 0
        ? undefined
        : top
            .slice(insertIndex + 1)
            .find((t) => ["WITH", "SELECT"].includes(word(t)));
    if (source)
      blocks.push({
        scope: {
          id: `scope:${source.start}`,
          parentId: block.scope.id,
          relations: [],
          projections: [],
          canCorrelate: false,
        },
        start: source.start,
        end: block.end,
        depth: block.depth,
        tokens: [],
      });
  }
  blocks.sort((a, b) => a.start - b.start || b.end - a.end);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    block.scope.parentId = blocks
      .slice(0, i)
      .reverse()
      .find(
        (parent) => parent.start <= block.start && parent.end >= block.end
      )?.scope.id;
  }
  for (const token of tokens) {
    const block = [...blocks]
      .reverse()
      .find((b) => token.start >= b.start && token.start < b.end)!;
    block.tokens.push(token);
  }
  const active =
    [...blocks].reverse().find((b) => offset >= b.start && offset <= b.end) ??
    root;
  context.scopeId = active.scope.id;
  context.scopes = blocks.map((b) => b.scope);

  // Register WITH names in their own block and expose them only to descendants.
  const ctesByBlock = new Map<Block, SqlToken[]>();
  for (const block of blocks) {
    const top = block.tokens.filter((t) => depths.get(t) === block.depth);
    const ctes: SqlToken[] = [];
    if (word(top[0]) === "WITH") {
      for (let i = 1; i < top.length; i++) {
        const token = top[i];
        if (["SELECT", "UPDATE", "DELETE", "INSERT"].includes(word(token)))
          break;
        if (
          identifier(token) &&
          (["WITH", "RECURSIVE"].includes(word(top[i - 1])) ||
            top[i - 1]?.text === ",")
        )
          ctes.push(token);
      }
      context.confidence = "partial";
    }
    ctesByBlock.set(block, ctes);
  }
  const declarations = new Map<Block, Declaration[]>();
  for (const block of blocks) {
    const top = block.tokens.filter((t) => depths.get(t) === block.depth);
    const ctes = blocks
      .filter(
        (parent) => parent.start <= block.start && parent.end >= block.end
      )
      .flatMap((parent) => ctesByBlock.get(parent) ?? []);
    const found: Declaration[] = [];
    let from = false;
    for (let i = 0; i < top.length; i++) {
      const keyword = word(top[i]);
      if (
        [
          "WHERE",
          "ON",
          "GROUP",
          "HAVING",
          "ORDER",
          "SET",
          "VALUES",
          "RETURNING",
          "LIMIT",
          "UNION",
        ].includes(keyword)
      )
        from = false;
      const target =
        keyword === "FROM" ||
        keyword === "JOIN" ||
        keyword === "UPDATE" ||
        (keyword === "INTO" && top.some((t) => word(t) === "INSERT")) ||
        (top[i].text === "," && from);
      if (!target) continue;
      from = keyword === "FROM" || keyword === "JOIN" || from;
      const first = top[i + 1];
      if (!first) continue;
      let endIndex = i + 1;
      let relation: RelationSymbol | undefined;
      if (first.text === "(") {
        const close = matching.get(first.start) ?? statement.end;
        endIndex = top.findIndex((t, index) => index > i && t.start === close);
        if (endIndex < 0) endIndex = top.length - 1;
        relation = {
          id: `${block.scope.id}:relation:${first.start}`,
          kind: "derived",
          name: "",
          outputColumns: [],
        };
      } else if (identifier(first)) {
        const parts = [first];
        while (
          top[endIndex + 1]?.text === "." &&
          identifier(top[endIndex + 2])
        ) {
          parts.push(top[endIndex + 2]);
          endIndex += 2;
        }
        const cte =
          parts.length === 1 &&
          ctes.some((t) =>
            dialect === "postgres"
              ? (t.quoted
                  ? name(t)
                  : name(t).replace(/[A-Z]/g, (c) => c.toLowerCase())) ===
                (first.quoted
                  ? name(first)
                  : name(first).replace(/[A-Z]/g, (c) => c.toLowerCase()))
              : name(t).toLowerCase() === name(first).toLowerCase()
          );
        relation = {
          id: `${block.scope.id}:relation:${first.start}`,
          kind: cte ? "cte" : parts.length > 2 ? "derived" : "table",
          name: name(parts[parts.length - 1]),
          nameQuoted: parts[parts.length - 1].quoted,
        };
        if (parts.length === 2) {
          relation.namespace = name(first);
          relation.namespaceQuoted = first.quoted;
        }
        if (
          parts.some((t) => !isClosedSqlIdentifier(t)) ||
          top[endIndex + 1]?.text === "."
        ) {
          relation.kind = "derived";
          context.confidence = "partial";
        }
        const next = top[endIndex + 1];
        if (next?.text === "(" && keyword !== "INTO") {
          relation.kind = "derived";
          relation.outputColumns = [];
          const close = matching.get(next.start);
          const index = top.findIndex((t) => t.start === close);
          endIndex = index < 0 ? top.length - 1 : index;
        }
      }
      if (!relation) {
        context.confidence = "partial";
        continue;
      }
      let alias = endIndex + 1;
      if (word(top[alias]) === "AS") alias++;
      if (identifier(top[alias])) {
        relation.alias = name(top[alias]);
        relation.aliasQuoted = top[alias].quoted;
        endIndex = alias;
      }
      const declaration: Declaration = {
        relation,
        start: first.start,
        end: top[endIndex]?.end ?? first.end,
      };
      if (keyword === "INTO" && top[endIndex + 1]?.text === "(") {
        declaration.listOpen = top[endIndex + 1].start;
        declaration.listClose =
          matching.get(declaration.listOpen) ?? statement.end;
      }
      found.push(declaration);
      block.scope.relations.push(relation);
      i = endIndex;
    }
    declarations.set(block, found);
  }

  // Set operations require branch-aware binding; suppress relations before any early return.
  const unsupportedSet = active.tokens.some((t) =>
    ["UNION", "INTERSECT", "EXCEPT"].includes(word(t))
  );
  if (unsupportedSet) {
    context.confidence = "unknown";
    active.scope.relations = [];
  }

  const cursorToken = all.find((t) => t.start < offset && t.end >= offset);
  if (cursorToken?.kind === "string" || cursorToken?.kind === "comment") {
    const inside =
      offset < cursorToken.end ||
      (cursorToken.kind === "comment"
        ? !cursorToken.text.startsWith("/*") || !cursorToken.text.endsWith("*/")
        : !stringClosed(cursorToken));
    if (inside) {
      context.slot = "none";
      return context;
    }
  }
  const editable = tokens.find(
    (t) =>
      (t.kind === "identifier" || t.kind === "keyword") &&
      t.start < offset &&
      t.end >= offset
  );
  if (editable) {
    context.prefix = decodeSqlIdentifier(
      editable.text.slice(0, offset - editable.start),
      editable.quoted
    );
    context.edit = { start: editable.start, end: editable.end };
    if (editable.quoted && !isClosedSqlIdentifier(editable))
      context.confidence = "partial";
  }
  let q = editable
    ? tokens.indexOf(editable) - 1
    : tokens.findIndex((t) => t.start >= offset) - 1;
  if (!editable && q === -2) q = tokens.length - 1;
  while (q >= 1 && tokens[q].text === "." && identifier(tokens[q - 1])) {
    context.qualifierParts.unshift(name(tokens[q - 1]));
    context.qualifierQuoted!.unshift(tokens[q - 1].quoted);
    q -= 2;
  }
  const before = active.tokens.filter(
    (t) => t.end <= (editable?.start ?? offset)
  );
  const topBefore = before.filter((t) => depths.get(t) === active.depth);
  let clauseIndex = -1;
  for (let i = 0; i < topBefore.length; i++) {
    const current = word(topBefore[i]);
    let clause: SqlClause | undefined;
    if (
      [
        "SELECT",
        "FROM",
        "JOIN",
        "ON",
        "WHERE",
        "HAVING",
        "UPDATE",
        "SET",
        "VALUES",
        "DELETE",
      ].includes(current)
    )
      clause = current.toLowerCase() as SqlClause;
    if (current === "INTO") clause = "insertInto";
    if (current === "GROUP" && word(topBefore[i + 1]) === "BY") {
      clause = "groupBy";
      i++;
    }
    if (current === "ORDER" && word(topBefore[i + 1]) === "BY") {
      clause = "orderBy";
      i++;
    }
    if (clause) {
      context.clause = clause;
      clauseIndex = i;
    }
  }
  const activeDeclarations = declarations.get(active)!;
  const insert = activeDeclarations.find(
    (d) =>
      d.listOpen !== undefined && offset > d.listOpen && offset <= d.listClose!
  );
  if (insert) {
    context.clause = "insertColumns";
    context.slot = "columnList";
    active.scope.relations = [insert.relation];
    context.excludedColumns = tokens
      .filter(
        (t) =>
          t.start > insert.listOpen! &&
          t.end <= insert.listClose! &&
          identifier(t) &&
          t !== editable
      )
      .map((t) => semanticName(t, dialect));
    return context;
  }
  if (["from", "join", "update", "insertInto"].includes(context.clause)) {
    const lastClause = topBefore[clauseIndex];
    const afterClause = activeDeclarations.filter(
      (d) => d.start >= (lastClause?.end ?? 0)
    );
    const decl =
      [...afterClause].reverse().find((d) => d.start <= offset) ??
      afterClause[0];
    context.slot =
      !decl ||
      offset <= decl.end ||
      topBefore[topBefore.length - 1]?.text === ","
        ? "table"
        : "continuation";
    // Alias text, AS and completed declarations are relation continuation, not table names.
    if (
      decl?.relation.alias &&
      editable &&
      editable.start > decl.start &&
      !context.qualifierParts.length
    )
      context.slot = "continuation";
    if (word(topBefore[topBefore.length - 1]) === "AS")
      context.slot = "continuation";
    return context;
  }
  if (context.clause === "set") {
    const set = topBefore[clauseIndex];
    const assignment = before.filter((t) => t.start > set.end);
    let segment = 0;
    for (let i = 0; i < assignment.length; i++)
      if (
        assignment[i].text === "," &&
        depths.get(assignment[i]) === active.depth
      )
        segment = i + 1;
    const current = assignment.slice(segment);
    const rhs = current.some(
      (t) => t.text === "=" && depths.get(t) === active.depth
    );
    if (rhs) context.operator = operatorContinuation(current);
    context.slot = rhs
      ? expressionSlot(current, "column")
      : current.length && !context.qualifierParts.length
        ? "keyword"
        : "columnList";
    if (context.slot === "columnList") {
      const setTokens = active.tokens.filter(
        (t) => t.start > set.end && depths.get(t) === active.depth
      );
      let targetStart = true;
      for (let i = 0; i < setTokens.length; i++) {
        const token = setTokens[i];
        if (
          ["WHERE", "FROM", "RETURNING", "OUTPUT", "ORDER", "LIMIT"].includes(
            word(token)
          )
        )
          break;
        if (token.text === ",") {
          targetStart = true;
          continue;
        }
        if (!targetStart) continue;
        targetStart = false;
        if (!identifier(token)) continue;
        let target = token;
        while (setTokens[i + 1]?.text === "." && identifier(setTokens[i + 2])) {
          target = setTokens[i + 2];
          i += 2;
        }
        if (target !== editable && setTokens[i + 1]?.text === "=")
          context.excludedColumns.push(semanticName(target, dialect));
      }
    }
    return context;
  }
  if (context.clause === "on" && !unsupportedSet) {
    const introduced = activeDeclarations.filter((d) => d.start < offset);
    active.scope.relations = introduced.map((d) => d.relation);
    if (introduced.length > 1)
      context.join = {
        leftRelationIds: introduced.slice(0, -1).map((d) => d.relation.id),
        rightRelationId: introduced[introduced.length - 1].relation.id,
      };
  }
  if (
    [
      "select",
      "where",
      "on",
      "groupBy",
      "having",
      "orderBy",
      "values",
    ].includes(context.clause)
  ) {
    const clauseStart = topBefore[clauseIndex]?.end ?? statement.start;
    context.operator = operatorContinuation(
      before.filter((t) => t.start >= clauseStart)
    );
    context.slot = context.qualifierParts.length
      ? context.clause === "on"
        ? "joinCondition"
        : "column"
      : expressionSlot(
          before.filter((t) => t.start >= clauseStart),
          context.clause === "on" ? "joinCondition" : "column"
        );
  }
  // Set operations need branch-aware output binding beyond this first implementation.
  if (
    active.tokens.some((t) =>
      ["UNION", "INTERSECT", "EXCEPT"].includes(word(t))
    )
  ) {
    context.confidence = "unknown";
    active.scope.relations = [];
  }
  return context;
}

function operatorContinuation(
  tokens: SqlToken[]
): SqlCompletionContext["operator"] {
  const last = word(tokens[tokens.length - 1]);
  if (last !== "NOT" && last !== "IS") return undefined;
  const compound = last === "NOT" && word(tokens[tokens.length - 2]) === "IS";
  const operand = tokens[tokens.length - (compound ? 3 : 2)];
  if (
    !operand ||
    !(
      operand.kind === "identifier" ||
      operand.kind === "number" ||
      operand.kind === "string" ||
      operand.text === ")" ||
      ["NULL", "TRUE", "FALSE", "END"].includes(word(operand))
    )
  )
    return undefined;
  return compound ? "IS NOT" : last;
}

function expressionSlot(
  tokens: SqlToken[],
  expression: "column" | "joinCondition"
): SqlCompletionContext["slot"] {
  const last = tokens[tokens.length - 1];
  if (operatorContinuation(tokens)) return "keyword";
  if (
    !last ||
    last.kind === "operator" ||
    ["(", ",", "."].includes(last.text) ||
    [
      "AND",
      "OR",
      "NOT",
      "WHEN",
      "THEN",
      "ELSE",
      "BY",
      "DISTINCT",
      "ALL",
      "IN",
      "LIKE",
      "ILIKE",
      "BETWEEN",
      "IS",
    ].includes(word(last))
  )
    return expression;
  return "keyword";
}

function stringClosed(token: SqlToken): boolean {
  if (token.text.startsWith("$")) {
    const delimiter = token.text.match(/^\$[^$]*\$/)?.[0];
    return (
      !!delimiter &&
      token.text.length >= delimiter.length * 2 &&
      token.text.endsWith(delimiter)
    );
  }
  return isClosedSqlIdentifier(token);
}

import type { SqlDialect } from "./sqlCompletion";
import type {
  ParsedFromRef,
  ParsedQueryBlock,
} from "./sqlCompletionScopeParser";
import {
  resolveSqlName,
  sqlIdentifierName,
} from "./sqlCompletionMetadataIndex";
import { decodeSqlIdentifier } from "./sqlCompletionTokenizer";
import type { ColumnSymbol, SqlToken } from "./sqlCompletionTypes";

export interface ProjectionInference {
  columns: ColumnSymbol[];
  complete: boolean;
}

function identifier(token: SqlToken | undefined): token is SqlToken {
  return token?.kind === "identifier";
}

function semanticName(token: SqlToken, dialect: SqlDialect): string {
  return sqlIdentifierName(
    decodeSqlIdentifier(token.text, token.quoted),
    token.quoted,
    dialect
  );
}

function isDot(token: SqlToken | undefined): boolean {
  return token?.text === ".";
}

function refForQualifier(
  tokens: SqlToken[],
  refs: ParsedFromRef[],
  dialect: SqlDialect
): ParsedFromRef | undefined {
  const parts = tokens.filter((_, index) => index % 2 === 0);
  if (
    (parts.length !== 1 && parts.length !== 2) ||
    !parts.every(identifier) ||
    tokens.some((token, index) => index % 2 === 1 && !isDot(token))
  )
    return undefined;
  let eligible = refs;
  if (parts.length === 2) {
    const namespaces = refs.filter(
      (ref) => ref.alias === undefined && ref.namespace !== undefined
    );
    const resolvedNamespace = resolveSqlName(
      decodeSqlIdentifier(parts[0].text, parts[0].quoted),
      parts[0].quoted,
      [
        ...new Set(
          namespaces.map((ref) =>
            sqlIdentifierName(
              ref.namespace!,
              ref.namespaceQuoted ?? false,
              dialect
            )
          )
        ),
      ],
      dialect
    );
    if (resolvedNamespace === undefined) return undefined;
    eligible = namespaces.filter(
      (ref) =>
        sqlIdentifierName(
          ref.namespace!,
          ref.namespaceQuoted ?? false,
          dialect
        ) === resolvedNamespace
    );
  }
  const relationName = (ref: ParsedFromRef) =>
    sqlIdentifierName(
      ref.alias ?? ref.name,
      ref.alias === undefined ? ref.nameQuoted : (ref.aliasQuoted ?? false),
      dialect
    );
  const lastPart = parts[parts.length - 1];
  const resolved = resolveSqlName(
    decodeSqlIdentifier(lastPart.text, lastPart.quoted),
    lastPart.quoted,
    eligible.map(relationName),
    dialect
  );
  if (resolved === undefined) return undefined;
  const matched = eligible.filter((ref) => relationName(ref) === resolved);
  return matched.length === 1 ? matched[0] : undefined;
}

function asColumn(
  tokens: SqlToken[],
  refs: ParsedFromRef[],
  columnsOf: (relationId: string) => ColumnSymbol[] | undefined,
  dialect: SqlDialect
): ColumnSymbol | undefined {
  const isSimple = tokens.length === 1 && identifier(tokens[0]);
  const isQualified =
    (tokens.length === 3 || tokens.length === 5) &&
    tokens.every((token, index) =>
      index % 2 === 0 ? identifier(token) : isDot(token)
    );
  if (!isSimple && !isQualified) return undefined;
  const name = tokens[tokens.length - 1];
  const target = isQualified
    ? refForQualifier(tokens.slice(0, -2), refs, dialect)
    : undefined;
  if (isQualified && !target) return undefined;
  const sources = isQualified ? [target!] : refs;
  if (sources.length === 0) return undefined;
  const found: Array<{ column: ColumnSymbol; ref: ParsedFromRef }> = [];
  for (const ref of sources) {
    const columns = columnsOf(ref.id);
    // An unknown source may contain this name, so even a known match is ambiguous.
    if (!columns) return undefined;
    for (const column of columns) found.push({ column, ref });
  }
  const resolved = resolveSqlName(
    decodeSqlIdentifier(name.text, name.quoted),
    name.quoted,
    found.map((entry) => entry.column.name),
    dialect
  );
  if (resolved === undefined) return undefined;
  const matches = found.filter((entry) => entry.column.name === resolved);
  if (matches.length !== 1) return undefined;
  const { column, ref } = matches[0];
  return { ...column, source: { relationId: ref.id, column: column.name } };
}

function projectionAlias(
  tokens: SqlToken[]
): { token: SqlToken; expression: SqlToken[] } | undefined {
  const last = tokens[tokens.length - 1];
  if (!identifier(last) || tokens.length < 2) return undefined;
  const before = tokens[tokens.length - 2];
  if (before.kind === "keyword" && before.text.toUpperCase() === "AS")
    return tokens.length > 2
      ? { token: last, expression: tokens.slice(0, -2) }
      : undefined;
  if (
    before.text.toUpperCase() === "COLLATE" ||
    !(
      before.kind === "identifier" ||
      before.kind === "number" ||
      before.kind === "string" ||
      before.text === ")" ||
      ["END", "NULL", "TRUE", "FALSE"].includes(before.text.toUpperCase())
    )
  )
    return undefined;
  return { token: last, expression: tokens.slice(0, -1) };
}

function isStar(tokens: SqlToken[]): boolean {
  return tokens.length === 1 && tokens[0].text === "*";
}

function starQualifier(tokens: SqlToken[]): SqlToken[] | undefined {
  if (tokens.length !== 3 && tokens.length !== 5) return undefined;
  if (
    tokens[tokens.length - 1]?.text !== "*" ||
    !isDot(tokens[tokens.length - 2])
  )
    return undefined;
  const qualifier = tokens.slice(0, -2);
  return qualifier.every((token, index) =>
    index % 2 === 0 ? identifier(token) : isDot(token)
  )
    ? qualifier
    : undefined;
}

function hasInvalidWildcard(tokens: SqlToken[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.text === "*") {
      const previous = tokens[i - 1];
      if (previous?.text === "." || i === 0) return true;
      if (previous?.text === "(") {
        const countStar =
          tokens[i - 2]?.text.toUpperCase() === "COUNT" &&
          tokens[i + 1]?.text === ")";
        if (!countStar) return true;
      } else if (previous?.kind === "operator") return true;
    }
  }
  return false;
}

function complexItem(tokens: SqlToken[]): boolean {
  const words = tokens.map((token) => token.text.toUpperCase());
  if (
    words.some((word) =>
      ["APPLY", "COLUMNS", "REPLACE", "EXCEPT", "OVER", "TRANSFORM"].includes(
        word
      )
    )
  )
    return true;
  if (words[0] === "DISTINCT" && words[1] === "ON") return true;
  let depth = 0;
  for (const token of tokens) {
    if (token.text === "(") depth++;
    if (token.text === ")") depth--;
    if (depth < 0) return true;
  }
  return depth !== 0;
}

/** Infer only output names that can be justified by this SELECT and its known FROM instances. */
export function inferSqlProjection(
  block: ParsedQueryBlock,
  columnsOf: (relationId: string) => ColumnSymbol[] | undefined,
  dialect: SqlDialect
): ProjectionInference {
  const columns: ColumnSymbol[] = [];
  let complete = !block.unsupported && block.selectItems.length > 0;
  for (const rawItem of block.selectItems) {
    const item = rawItem.filter((token) => token.kind !== "comment");
    if (item.length === 0) {
      complete = false;
      continue;
    }
    const alias = projectionAlias(item);
    const expression = alias?.expression ?? item;
    const complicated = complexItem(expression);
    if (complicated) complete = false;
    const plainStar = !alias && isStar(expression);
    const qualifier = !alias && starQualifier(expression);
    if (!plainStar && !qualifier && hasInvalidWildcard(expression)) {
      complete = false;
      continue;
    }
    if (plainStar) {
      if (block.joinsMergeColumns) {
        complete = false;
        continue;
      }
      if (block.from.length === 0) complete = false;
      for (const ref of block.from) {
        const source = columnsOf(ref.id);
        if (!source) {
          complete = false;
          continue;
        }
        columns.push(
          ...source.map((column) => ({
            ...column,
            source: { relationId: ref.id, column: column.name },
          }))
        );
      }
      continue;
    }
    if (qualifier) {
      const ref = refForQualifier(qualifier, block.from, dialect);
      const source = ref ? columnsOf(ref.id) : undefined;
      if (!ref || !source) {
        complete = false;
        continue;
      }
      columns.push(
        ...source.map((column) => ({
          ...column,
          source: { relationId: ref.id, column: column.name },
        }))
      );
      continue;
    }
    if (alias) {
      const source = complicated
        ? undefined
        : asColumn(expression, block.from, columnsOf, dialect);
      columns.push({
        name: semanticName(alias.token, dialect),
        quoted: alias.token.quoted,
        ...(source?.type ? { type: source.type } : {}),
        ...(source?.source ? { source: source.source } : {}),
      });
      continue;
    }
    const source = complicated
      ? undefined
      : asColumn(expression, block.from, columnsOf, dialect);
    if (source)
      columns.push({
        ...source,
        quoted: expression[expression.length - 1].quoted,
      });
    else complete = false;
  }
  return { columns, complete };
}

/** SQL set operations inherit their names from the first branch. */
export function combineSqlSetProjection(
  branches: ProjectionInference[]
): ProjectionInference {
  if (branches.length === 0) return { columns: [], complete: false };
  const first = branches[0];
  return {
    columns: first.columns,
    complete: branches.every(
      (branch) =>
        branch.complete && branch.columns.length === first.columns.length
    ),
  };
}

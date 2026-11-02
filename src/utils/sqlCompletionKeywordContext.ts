import type { SqlDialect } from "./sqlCompletion";
import { isClosedSqlIdentifier } from "./sqlCompletionTokenizer";
import type { SqlToken } from "./sqlCompletionTypes";

type CaseStage = "case" | "when" | "then" | "else";
interface CaseFrame {
  depth: number;
  stage: CaseStage;
  expressionStart: number;
}

/** Quoted identifiers and qualified names never act as structural keywords. */
function wordAt(
  tokens: readonly SqlToken[],
  index: number
): string | undefined {
  const token = tokens[index];
  if (
    !token ||
    token.quoted ||
    (token.kind !== "keyword" && token.kind !== "identifier") ||
    tokens[index - 1]?.text === "."
  )
    return undefined;
  return token.text.toUpperCase();
}

function isClosedValue(token: SqlToken): boolean {
  if (!token.quoted) return true;
  const dollar = token.text.match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
  return dollar
    ? token.text.length >= dollar.length * 2 && token.text.endsWith(dollar)
    : isClosedSqlIdentifier(token);
}

/** Find an unfinished BETWEEN at this expression's own parenthesis/CASE depth. */
function pendingBetween(tokens: readonly SqlToken[]): number | undefined {
  let depth = 0;
  let cases = 0;
  let between: number | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.text === "(") depth++;
    else if (token.text === ")") depth--;
    if (depth !== 0) continue;
    const word = wordAt(tokens, i);
    if (word === "CASE") cases++;
    else if (word === "END") cases--;
    if (cases !== 0) continue;
    if (word === "BETWEEN") between = i;
    else if (word === "AND") between = undefined;
  }
  return between;
}

/** A local end-of-expression check, deliberately not an expression parser. */
function expressionComplete(tokens: readonly SqlToken[]): boolean {
  const last = tokens[tokens.length - 1];
  if (!last || !isClosedValue(last)) return false;
  const endWord = wordAt(tokens, tokens.length - 1);
  if (
    last.kind !== "identifier" &&
    last.kind !== "number" &&
    last.kind !== "string" &&
    last.text !== ")" &&
    !["NULL", "TRUE", "FALSE", "END"].includes(endWord ?? "")
  )
    return false;
  // BETWEEN's first operand is not a complete condition until AND is present.
  return pendingBetween(tokens) === undefined;
}

function betweenKeywords(tokens: readonly SqlToken[]): string[] | undefined {
  const start = pendingBetween(tokens);
  return start !== undefined && expressionComplete(tokens.slice(start + 1))
    ? ["AND"]
    : undefined;
}

function conditionKeywords(dialect: SqlDialect): string[] {
  return [
    "THEN",
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

function paginationKeywords(
  tokens: readonly SqlToken[],
  dialect: SqlDialect
): string[] | undefined {
  let start = -1;
  for (let i = 0; i < tokens.length; i++) {
    const word = wordAt(tokens, i);
    if (word === "SELECT" || word === "UNION" || word === "RETURNING")
      start = -1;
    else if (word === "LIMIT" || word === "OFFSET" || word === "FETCH")
      start = i;
  }
  if (start < 0) return undefined;
  const word = wordAt(tokens, start);
  const tail = tokens.slice(start + 1);
  if (word === "LIMIT") {
    return dialect !== "sqlserver" &&
      tail.length === 1 &&
      tail[0].kind === "number"
      ? ["OFFSET"]
      : [];
  }
  const standardPaging = dialect === "postgres" || dialect === "sqlserver";
  if (!standardPaging) return [];
  if (word === "OFFSET") {
    if (tail.length === 1 && tail[0].kind === "number") return ["ROWS"];
    if (
      tail.length === 2 &&
      tail[0].kind === "number" &&
      ["ROW", "ROWS"].includes(wordAt(tail, 1) ?? "")
    )
      return ["FETCH NEXT", "FETCH FIRST"];
    return [];
  }
  if (!tail.length) return ["NEXT", "FIRST"];
  if (!["NEXT", "FIRST"].includes(wordAt(tail, 0) ?? "")) return [];
  if (tail.length === 2 && tail[1].kind === "number") return ["ROWS ONLY"];
  if (
    tail.length === 3 &&
    tail[1].kind === "number" &&
    ["ROW", "ROWS"].includes(wordAt(tail, 2) ?? "")
  )
    return ["ONLY"];
  return [];
}

/**
 * Complete only the missing keyword in a recognized query prefix. The caller
 * supplies the active query's complete tokens, excluding its editable token.
 * undefined retains its normal table/column context; [] owns a keyword context
 * that has no safe keyword continuation (for example a completed LIMIT/OFFSET).
 */
export function getSqlQueryPrefixKeywords(
  tokensBefore: readonly SqlToken[],
  dialect: SqlDialect
): string[] | undefined {
  const tokens = tokensBefore.filter((token) => token.kind !== "comment");
  const cases: CaseFrame[] = [];
  const topLevel: SqlToken[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.text === "(") {
      if (depth === 0 && !cases.length) topLevel.push(token);
      depth++;
      continue;
    }
    if (token.text === ")") {
      depth--;
      if (depth === 0 && !cases.length) topLevel.push(token);
      continue;
    }
    const word = wordAt(tokens, i);
    if (word === "CASE") {
      cases.push({ depth, stage: "case", expressionStart: i + 1 });
      continue;
    }
    const frame = cases[cases.length - 1];
    if (frame && frame.depth === depth) {
      if (word === "END") cases.pop();
      else if (word === "WHEN" || word === "THEN" || word === "ELSE") {
        frame.stage = word.toLowerCase() as CaseStage;
        frame.expressionStart = i + 1;
      }
      continue;
    }
    if (depth === 0 && !cases.length) topLevel.push(token);
  }
  const frame = cases[cases.length - 1];
  if (frame) {
    if (depth !== frame.depth) return undefined;
    const expression = tokens.slice(frame.expressionStart);
    if (frame.stage === "case" && !expression.length) return ["WHEN"];
    const between = betweenKeywords(expression);
    if (between) return between;
    if (!expressionComplete(expression)) return undefined;
    if (frame.stage === "case") return ["WHEN"];
    if (frame.stage === "when") return conditionKeywords(dialect);
    return frame.stage === "then" ? ["WHEN", "ELSE", "END"] : ["END"];
  }
  // Ordinary function arguments, window frames and nested expressions keep their
  // existing name completion, even when their last token spells a query keyword.
  if (depth !== 0) return undefined;
  const between = betweenKeywords(topLevel);
  if (between) return between;
  const lastWord = wordAt(topLevel, topLevel.length - 1);
  const previousWord = wordAt(topLevel, topLevel.length - 2);
  if (lastWord === "GROUP" || lastWord === "ORDER") return ["BY"];
  if (lastWord === "FULL" && dialect === "mysql") return [];
  if (["LEFT", "RIGHT", "FULL"].includes(lastWord ?? ""))
    return ["JOIN", "OUTER JOIN"];
  if (lastWord === "INNER" || lastWord === "CROSS") return ["JOIN"];
  if (
    lastWord === "OUTER" &&
    ["LEFT", "RIGHT", "FULL"].includes(previousWord ?? "")
  )
    return previousWord === "FULL" && dialect === "mysql" ? [] : ["JOIN"];
  if (lastWord === "UNION") return ["SELECT", "ALL SELECT"];
  if (
    ((lastWord === "ALL" || lastWord === "DISTINCT") &&
      previousWord === "UNION") ||
    lastWord === "INTERSECT" ||
    lastWord === "EXCEPT"
  )
    return ["SELECT"];
  return paginationKeywords(topLevel, dialect);
}

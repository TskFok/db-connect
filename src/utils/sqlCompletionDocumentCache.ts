import type { SqlDialect } from "./sqlCompletion";
import type { SqlToken } from "./sqlCompletionTypes";
import { scanSqlTokens } from "./sqlCompletionTokenizer";
import {
  parseSqlQueryBlocksFromTokens,
  type ParsedQueryBlock,
} from "./sqlCompletionScopeParser";

export interface SqlDocumentChange {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}
interface StatementChunk {
  start: number;
  /** Local end excludes the separator; next chunk starts after its entire token. */
  end: number;
  tokens: SqlToken[];
}
const shiftToken = (token: SqlToken, delta: number): SqlToken => ({
  ...token,
  start: token.start + delta,
  end: token.end + delta,
});
const shiftRange = (range: { start: number; end: number }, delta: number) => ({
  start: range.start + delta,
  end: range.end + delta,
});
function shiftBlocks(
  blocks: readonly ParsedQueryBlock[],
  delta: number
): ParsedQueryBlock[] {
  const id = (value: string) =>
    value.replace(/\d+/g, (n) => String(Number(n) + delta));
  return blocks.map((block) => ({
    ...block,
    id: id(block.id),
    ...(block.parentId === undefined ? {} : { parentId: id(block.parentId) }),
    range: shiftRange(block.range, delta),
    selectItems: block.selectItems.map((items) =>
      items.map((t) => shiftToken(t, delta))
    ),
    from: block.from.map((ref) => ({
      ...ref,
      id: id(ref.id),
      declarationStart: ref.declarationStart + delta,
      ...(ref.bodyScopeId === undefined
        ? {}
        : { bodyScopeId: id(ref.bodyScopeId) }),
    })),
    ctes: block.ctes.map((cte) => ({
      ...cte,
      bodyScopeId: id(cte.bodyScopeId),
    })),
    clauses: block.clauses.map((clause) => ({
      ...clause,
      ...shiftRange(clause, delta),
    })),
    ...(block.setBranchIds === undefined
      ? {}
      : { setBranchIds: block.setBranchIds.map(id) }),
  }));
}

/** Current-version syntax only: token coordinates are local to each statement.
 * Separators are emitted only in ordinary lexical state, making their ends safe
 * restart points. The scanner always receives the whole text to preserve GO's
 * line context even when a checkpoint immediately follows a semicolon.
 */
export function createSqlCompletionDocumentCache(
  initialText: string,
  initialVersion: number,
  initialDialect: SqlDialect
) {
  let text = initialText;
  let version = initialVersion;
  let dialect = initialDialect;
  let disposed = false;
  let chunks: StatementChunk[] = [];
  const parsed = new Map<StatementChunk, ParsedQueryBlock[]>();

  function locate(offset: number): number {
    let lo = 0;
    let hi = chunks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (chunks[mid].start <= offset) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - 1);
  }

  function scan(
    start: number,
    stop?: (nextStart: number) => boolean
  ): StatementChunk[] {
    const result: StatementChunk[] = [];
    let current: StatementChunk = { start, end: 0, tokens: [] };
    let stopped = false;
    scanSqlTokens(text, dialect, start, (token) => {
      if (
        token.kind === "punctuation" &&
        (token.text === ";" || token.text.toUpperCase() === "GO")
      ) {
        current.end = token.start - current.start;
        result.push(current);
        if (stop?.(token.end)) {
          stopped = true;
          return false;
        }
        current = { start: token.end, end: 0, tokens: [] };
      } else {
        // A substring can retain its entire source document in V8/JSC. Build
        // owned UTF-16 text only when persisting a newly scanned token; copying
        // via code units also preserves incomplete surrogate pairs from edits.
        // Do not copy in shiftToken: reads and cached query blocks reuse this text.
        current.tokens.push({
          ...token,
          start: token.start - current.start,
          end: token.end - current.start,
          text: token.text.split("").join(""),
        });
      }
    });
    if (!stopped) {
      current.end = text.length - current.start;
      result.push(current);
    }
    return result;
  }
  chunks = scan(0);

  return {
    applyChanges(
      changes: readonly SqlDocumentChange[],
      nextVersion: number
    ): boolean {
      if (
        disposed ||
        !Number.isInteger(nextVersion) ||
        nextVersion !== version + 1
      )
        return false;
      const sorted = [...changes].sort((a, b) => a.rangeOffset - b.rangeOffset);
      let previousEnd = -1;
      let previousStart = -1;
      for (const change of sorted) {
        if (
          !Number.isInteger(change.rangeOffset) ||
          !Number.isInteger(change.rangeLength) ||
          change.rangeOffset < 0 ||
          change.rangeLength < 0 ||
          change.rangeOffset + change.rangeLength > text.length ||
          change.rangeOffset < previousEnd ||
          change.rangeOffset === previousStart
        )
          return false;
        previousStart = change.rangeOffset;
        previousEnd = change.rangeOffset + change.rangeLength;
      }
      if (!sorted.length) {
        version = nextVersion;
        return true;
      }
      let first = locate(sorted[0].rangeOffset);
      // A GO token depends on the rest of its line. Revisit it only when the
      // first edit can change that trailing whitespace/newline; semicolons
      // are unconditional boundaries, including insertion immediately after one.
      const start = chunks[first].start;
      if (
        first > 0 &&
        dialect === "sqlserver" &&
        text.slice(start - 2, start).toUpperCase() === "GO" &&
        /^[\t \r]*$/.test(text.slice(start, sorted[0].rangeOffset))
      )
        first--;
      const checkpoint = chunks[first].start;
      const last = sorted[sorted.length - 1];
      const oldEnd = last.rangeOffset + last.rangeLength;
      let delta = 0;
      for (let i = sorted.length - 1; i >= 0; i--) {
        const change = sorted[i];
        text =
          text.slice(0, change.rangeOffset) +
          change.text +
          text.slice(change.rangeOffset + change.rangeLength);
        delta += change.text.length - change.rangeLength;
      }
      let suffix = chunks.length;
      const replacement = scan(checkpoint, (nextStart) => {
        const oldStart = nextStart - delta;
        if (oldStart <= oldEnd) return false;
        const candidate = locate(oldStart);
        if (candidate > first && chunks[candidate].start === oldStart) {
          suffix = candidate;
          return true;
        }
        return false;
      });
      // Evict only replaced syntax. No historical token arrays are visited/copied.
      for (const chunk of parsed.keys()) {
        if (
          chunk.start >= checkpoint &&
          (suffix === chunks.length || chunk.start < chunks[suffix].start)
        )
          parsed.delete(chunk);
      }
      for (let i = suffix; i < chunks.length; i++) chunks[i].start += delta;
      if (suffix === chunks.length) {
        // Appending/editing the tail must not copy the historical chunk index.
        chunks.length = first;
        for (const chunk of replacement) chunks.push(chunk);
      } else if (replacement.length < 8192) {
        chunks.splice(first, suffix - first, ...replacement);
      } else {
        // Avoid the engine argument-count limit on very large replacements.
        chunks = chunks
          .slice(0, first)
          .concat(replacement, chunks.slice(suffix));
      }
      version = nextVersion;
      return true;
    },
    reset(
      nextText: string,
      nextVersion: number,
      nextDialect: SqlDialect
    ): void {
      text = nextText;
      version = nextVersion;
      dialect = nextDialect;
      disposed = false;
      parsed.clear();
      chunks = scan(0);
    },
    getStatement(offset: number): {
      statement: { start: number; end: number };
      tokens: readonly SqlToken[];
      blocks: readonly ParsedQueryBlock[];
    } {
      if (disposed) throw new Error("SQL document cache has been disposed");
      const chunk = chunks[locate(offset)];
      let blocks = parsed.get(chunk);
      if (!blocks)
        blocks = parseSqlQueryBlocksFromTokens(
          chunk.tokens,
          { start: 0, end: chunk.end },
          dialect
        );
      parsed.delete(chunk);
      parsed.set(chunk, blocks);
      if (parsed.size > 32) parsed.delete(parsed.keys().next().value!);
      return {
        statement: { start: chunk.start, end: chunk.start + chunk.end },
        tokens: chunk.tokens.map((token) => shiftToken(token, chunk.start)),
        blocks: shiftBlocks(blocks, chunk.start),
      };
    },
    dispose(): void {
      disposed = true;
      text = "";
      chunks = [];
      parsed.clear();
    },
  };
}

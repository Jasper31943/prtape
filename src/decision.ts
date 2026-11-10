import { bashSubstitutions } from "./bash-edits.js";
import type { SessionSummary } from "./types.js";

/**
 * One short decision from the edits that actually happened.
 * A test-file expectation change is not described as a source-code fix.
 * Returns undefined when the diff does not establish a single change.
 */
export function decisionFromEvents(summary: SessionSummary): string | undefined {
  const substitutions = substitutionsOf(summary);
  const expectation = substitutions.filter((item) => item.shift && isTestFile(item.file));
  const source = sourceReturn(summary);
  if (expectation.length === 1 && !source) {
    const item = expectation[0];
    const shift = item?.shift;
    if (!shift) return undefined;
    const sourceEdited = summary.events.some((event) => event.kind === "edit" && !isTestFile(event.path));
    if (!sourceEdited && shift.callee) {
      return `Correct test expectation from ${shift.from} to ${shift.to}; leave ${shift.callee}() unchanged.`;
    }
    return `Correct test expectation from ${shift.from} to ${shift.to}.`;
  }
  const small = expectation.length === 0 ? smallSourceEdit(summary) : undefined;
  if (expectation.length === 0 && source && small) return preferSpecific(source, small);
  if (expectation.length === 0 && source) return source;
  if (expectation.length === 0 && small) return small;
  return undefined;
}

function preferSpecific(source: string, small: string): string {
  const span = /use (.+) instead of /.exec(small)?.[1] ?? "";
  const expr = /return (.+)\.$/.exec(source)?.[1] ?? "";
  if (span && expr.includes(span) && span.length + 8 < expr.length) return small;
  return source.length <= small.length ? source : small;
}

function smallSourceEdit(summary: SessionSummary): string | undefined {
  const edits = summary.events.filter(
    (event): event is Extract<SessionSummary["events"][number], { kind: "edit" }> =>
      event.kind === "edit" && !isTestFile(event.path) && Boolean(event.before) && Boolean(event.after),
  );
  if (edits.length !== 1) return undefined;
  const edit = edits[0];
  if (!edit?.before || !edit.after) return undefined;
  const change = spanChange(edit.before, edit.after);
  if (!change) return undefined;
  const why = evidenceReason(summary);
  const sentence = why
    ? `${why}: use ${change.added}, not ${change.removed}.`
    : `In ${edit.path}, use ${change.added} instead of ${change.removed}.`;
  if (sentence.length > 180) return undefined;
  return sentence;
}

/** A short clause copied from a commit message, failing test name, or assistant line. */
function evidenceReason(summary: SessionSummary): string | undefined {
  for (const event of summary.events) {
    if (event.kind !== "commit" || !event.message) continue;
    const clause = reasonClause(event.message);
    if (clause) return clause;
  }
  for (const event of summary.events) {
    if (event.kind === "test" && event.failedName && isReasonSpan(event.failedName)) return event.failedName;
  }
  const prose = reasonClause(summary.decision);
  if (prose && summary.decision.includes(prose) && !isStatusReason(prose)) return prose;
  return undefined;
}

function reasonClause(message: string): string | undefined {
  const pieces = message
    .split(/\n+|(?<=[.!?])\s+|:\s+/)
    .map((piece) => piece.trim().replace(/^[.!?]+|[.!?]+$/g, "").trim())
    .filter((piece) => piece.length >= 12 && piece.length <= 90 && message.includes(piece));
  const descriptive = pieces.find((piece) => !/^(?:fix|update|change|commit)\b/i.test(piece));
  return descriptive ?? pieces[0];
}

function isReasonSpan(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 12 && trimmed.length <= 90 && trimmed.includes(" ") && !/^(?:fix|update|change)\b/i.test(trimmed);
}

function isStatusReason(text: string): boolean {
  return /\b(?:tests?|suite) (?:passed|passes|failed)\b/i.test(text) || /全部通過|測試通過/.test(text);
}

function spanChange(before: string, after: string): { removed: string; added: string } | undefined {
  if (!before || !after || before === after) return undefined;
  if (before.length > 2000 || after.length > 2000) return undefined;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  let removed = before.slice(start, endBefore);
  let added = after.slice(start, endAfter);
  if (!added && removed) {
    const extra = /[\w.]+$/.exec(before.slice(0, start))?.[0] ?? "";
    if (!extra) return undefined;
    removed = extra + removed;
    added = extra;
  } else if (!removed && added) {
    const extra = /[\w.]+$/.exec(after.slice(0, start))?.[0] ?? "";
    if (!extra) return undefined;
    added = extra + added;
    removed = extra;
  }
  removed = removed.trim();
  added = added.trim();
  if (!removed || !added || removed.length > 80 || added.length > 80) return undefined;
  return { removed, added };
}

interface Shift {
  from: string;
  to: string;
  callee?: string;
}

function substitutionsOf(summary: SessionSummary): { file: string; shift?: Shift }[] {
  const found: { file: string; shift?: Shift }[] = [];
  for (const event of summary.events) {
    if (event.kind === "test") {
      for (const item of bashSubstitutions(event.command)) {
        found.push({ file: item.file, shift: expectationShift(item.old, item.next) });
      }
    }
    if (event.kind === "edit" && event.before && event.after && isTestFile(event.path)) {
      found.push({ file: event.path, shift: expectationShift(event.before, event.after) });
    }
  }
  const seen = new Set<string>();
  return found.filter((item) => {
    const key = `${item.file}\0${item.shift?.from}\0${item.shift?.to}\0${item.shift?.callee ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function expectationShift(before: string, after: string): Shift | undefined {
  if (!before || !after || before === after) return undefined;
  if (before.length > 2000 || after.length > 2000) return undefined;
  const skeleton = (value: string) => value.replace(/-?\d+(?:\.\d+)?/g, "#");
  if (skeleton(before) !== skeleton(after)) return undefined;
  const numbers = (value: string) => [...value.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => match[0]);
  const left = numbers(before);
  const right = numbers(after);
  if (left.length === 0 || left.length !== right.length) return undefined;
  let from = "";
  let to = "";
  let diffs = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      diffs += 1;
      from = left[index] ?? "";
      to = right[index] ?? "";
    }
  }
  if (diffs !== 1) return undefined;
  return { from, to, callee: calleeName(before) };
}

function calleeName(text: string): string | undefined {
  const wrapped = /(?:assert\.\w+|expect)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(text);
  if (wrapped?.[1]) return wrapped[1];
  const direct = /(?:^|[^\w.])([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(text);
  return direct?.[1];
}

function sourceReturn(summary: SessionSummary): string | undefined {
  const edits = summary.events.filter(
    (event): event is Extract<SessionSummary["events"][number], { kind: "edit" }> =>
      event.kind === "edit" && !isTestFile(event.path) && Boolean(event.before) && Boolean(event.after),
  );
  if (edits.length !== 1) return undefined;
  const edit = edits[0];
  if (!edit?.before || !edit.after) return undefined;
  const before = /return\s+([^;\n]+)/.exec(edit.before);
  const after = /return\s+([^;\n]+)/.exec(edit.after);
  if (!before?.[1] || !after?.[1] || before[1].trim() === after[1].trim()) return undefined;
  const name =
    /function\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(edit.before)?.[1] ??
    /(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(edit.before)?.[1];
  const expr = after[1].trim();
  if (!name || expr.length > 40) return undefined;
  return `Change ${name}() to return ${expr}.`;
}

function isTestFile(filePath: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(filePath) || /_test\.[a-z]+$/i.test(filePath);
}

import { decisionFromEvents } from "./decision.js";
import type { RedactOptions } from "./redact.js";
import { redact } from "./redact.js";
import { hasPrivatePath, stripPrivatePaths } from "./privacy.js";
import { rollupTests, withSteps } from "./summary.js";
import { displayTestCommand } from "./tests-detect.js";
import type { SessionSummary, TimelineEvent } from "./types.js";
import { oneLine } from "./text.js";

const MARKER = /\[REDACTED_[A-Z0-9_]+\]/;

/** Locked KEY DECISION copy. The short form drops the second clause. */
export const LOCKED_DECISION = "Ship the redacted timeline; secrets stay off the PR.";

export interface Presented {
  summary: SessionSummary;
  /** True when a secret was removed from a string a reviewer might read. */
  secretsStripped: boolean;
  /** How many secret spans were removed. Drives the `redacted ×N` badge only. */
  maskedCount: number;
}

/**
 * Reviewer-facing copy. Sentences and shell assignments that contain a secret
 * are deleted. Nothing is replaced with a `[REDACTED_*]` token.
 */
export function presentSummary(input: SessionSummary, options: RedactOptions = {}): Presented {
  const probed = [input.title, input.decision, ...input.files.map((file) => file.path), ...input.tests.map((test) => test.command)].join("\n");
  const maskedCount = redact(probed, options).match(/\[REDACTED_[A-Z0-9_]+\]/g)?.length ?? 0;
  const secretsStripped = maskedCount > 0;

  const decision = scrubDecision(input.decision, input, options);
  const title = scrubTitle(input.title, options);
  const events = input.events.map((event) => scrubEvent(event, options)).filter((event): event is TimelineEvent => event !== undefined);

  return {
    secretsStripped,
    maskedCount,
    summary: withSteps({
      ...input,
      title: title || "Coding-agent session",
      decision,
      cwd: publicCwd(input.cwd),
      branch: input.branch ? stripPrivatePaths(input.branch) || undefined : undefined,
      events,
    }),
  };
}

export function scrubTitle(text: string, options: RedactOptions = {}): string {
  // Emails never lead the title. A sentence that is only an address is dropped.
  const clean = scrubProse(stripPastedWrappers(text), { ...options, emails: true });
  const sentences = splitSentences(clean).filter((sentence) => sentence && !isOnlyEmail(sentence));
  const task =
    sentences.find((sentence) => isTaskSentence(sentence)) ??
    sentences.find((sentence) => !isMetaInstruction(sentence)) ??
    sentences[0] ??
    "";
  return task;
}

const TASK_VERBS = /^(?:fix|make|add|find|implement|update|run|change|correct|strip|remove|keep)\b/i;

function isTaskSentence(sentence: string): boolean {
  return TASK_VERBS.test(sentence.trim());
}

/** Language, format, and disclaimer lines Claude Code puts ahead of the task. */
function isMetaInstruction(sentence: string): boolean {
  const text = sentence.trim().replace(/[.!?。]+$/g, "");
  return (
    /^(?:respond|answer|reply)\b(?:\s+\w+){0,6}\s+in\b/i.test(text) ||
    /^be concise\b/i.test(text) ||
    /^keep (?:it|this|your (?:answer|response)) (?:brief|short|concise)\b/i.test(text) ||
    /^this is an intentional\b/i.test(text) ||
    /\bnot a real\b.+\b(?:incident|customer|bug|session)\b/i.test(text) ||
    /^(?:note|context)\s*:/i.test(text)
  );
}

/** Drop Claude Code wrappers such as `<pasted_content id="...">...</pasted_content>`. */
export function stripPastedWrappers(text: string): string {
  let current = text;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = current.replace(/<([A-Za-z][\w:-]*)\b[^>]*>[\s\S]*?<\/\1>/g, (full) =>
      full.replace(/^<[^>]*>/, "").replace(/<\/[^>]*>$/, ""),
    );
    if (next === current) break;
    current = next;
  }
  return current
    .replace(/<\/?[A-Za-z][\w:-]*\b[^>]*>/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function scrubProse(text: string, options: RedactOptions = {}): string {
  const withoutFences = text.replace(/```[\s\S]*?```/g, "\n").replace(/~~~[\s\S]*?~~~/g, "\n");
  const kept = splitSentences(withoutFences)
    .filter((sentence) => !isPathReferenceSentence(sentence))
    .map((sentence) => cleanDisplayMarkdown(stripPrivatePaths(sentence)).trim())
    .filter((sentence) => sentence && !isPathReferenceSentence(sentence) && !sentenceHasSecret(sentence, options));
  return oneLine(kept.join(" "));
}

function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  for (const line of text.split(/\n+/)) {
    let current = "";
    const chars = [...line];
    for (let index = 0; index < chars.length; index += 1) {
      const ch = chars[index] ?? "";
      current += ch;
      const next = chars[index + 1];
      const cjkEnd = ch === "。" || ch === "！" || ch === "？";
      const enEnd = (ch === "." || ch === "!" || ch === "?") && (next === undefined || /\s/.test(next));
      if (!cjkEnd && !enEnd) continue;
      const trimmed = current.trim();
      if (trimmed) sentences.push(trimmed);
      current = "";
      if (next && /\s/.test(next)) index += 1;
    }
    const rest = current.trim();
    if (rest) sentences.push(rest);
  }
  return sentences;
}

/**
 * A sentence whose job is to point at a private path. Drop the whole sentence
 * so deletion does not leave "完整輸出存在 。" or "The full output is saved at ."
 */
export function isPathReferenceSentence(sentence: string): boolean {
  const hadPath = hasPrivatePath(sentence) || /`{2,}|`\s*`/.test(sentence);
  const core = locatorCore(sentence);
  if (!core) return hadPath;
  if (!isLocatorCore(core)) return false;
  return hadPath || isLocatorCore(core);
}

function locatorCore(sentence: string): string {
  return cleanDisplayMarkdown(stripPrivatePaths(sentence))
    .replace(/`+/g, "")
    .replace(/[。！？.!?]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const LOCATOR_WORDS = new Set([
  "the",
  "a",
  "an",
  "full",
  "output",
  "outputs",
  "log",
  "logs",
  "file",
  "files",
  "checkout",
  "note",
  "notes",
  "is",
  "are",
  "was",
  "were",
  "saved",
  "written",
  "stored",
  "located",
  "kept",
  "live",
  "lives",
  "at",
  "in",
  "under",
  "to",
  "on",
  "and",
  "of",
]);

function isLocatorCore(core: string): boolean {
  if (/^(?:完整|修正前的|修正後的)?輸出存在$/.test(core)) return true;
  if (/^(?:日誌|日志|記錄|檔案)(?:在|位於|存在)$/.test(core)) return true;
  const words = core
    .replace(/\/[^\s]+/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length === 0 || words.length > 12) return false;
  if (words.some((word) => /[\u3400-\u9fff]/.test(word))) return false;
  return words.every((word) => LOCATOR_WORDS.has(word.toLowerCase().replace(/^[("']+|[)"',]+$/g, "")));
}

/** Drop markdown markers and empty code spans left behind when a path was deleted. */
export function cleanDisplayMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`{1,3}\s*`{1,3}/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/`+/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function scrubCommand(command: string, options: RedactOptions = {}): string {
  const displayed = displayTestCommand(command);
  const source = displayed || command;
  const pieces = source.split(/\s*(?:&&|\|\||;)\s*/);
  const kept = pieces.map((piece) => scrubCommandPiece(piece, options)).filter((piece) => piece.length > 0);
  return oneLine(stripPrivatePaths(kept.join(" && ")));
}

function scrubDecision(text: string, summary: SessionSummary, options: RedactOptions): string {
  const prose = scrubProse(text, options);
  const explicit = explicitSentence(prose);
  if (explicit && explicit.replace(/[。．.]$/u, "") === "Ship the redacted timeline") return LOCKED_DECISION;
  if (explicit && !isStatusBoilerplate(explicit)) return finishSentence(explicit);
  const derived = decisionFromEvents(summary);
  if (derived) return derived;
  return fallbackDecision(summary);
}

/** One short statement. A multi-sentence status report is not a decision. */
function explicitSentence(prose: string): string | undefined {
  const sentences = splitSentences(prose).filter((sentence) => sentence.length >= 12 && sentence.length <= 180);
  if (sentences.length !== 1) return undefined;
  return sentences[0];
}

function isStatusBoilerplate(sentence: string): boolean {
  return (
    /^(?:修好了|完成了|done\b)/i.test(sentence) ||
    /全部通過|測試通過/.test(sentence) ||
    /\b(?:tests?|suite) (?:passed|passes|pass)\b/i.test(sentence) ||
    /^fixed the .+ so the (?:suite|tests)/i.test(sentence) ||
    /^the tests passed\b/i.test(sentence) ||
    /^原因與修正[:：]?$/.test(sentence) ||
    /^修正前的失敗結果/.test(sentence)
  );
}

function finishSentence(sentence: string): string {
  const trimmed = sentence.trim();
  if (/[。！？.!?]$/.test(trimmed)) return trimmed;
  return `${trimmed}.`;
}

function fallbackDecision(summary: SessionSummary): string {
  const count = summary.files.length;
  const files = count === 0 ? "" : `Edited ${count} file${count === 1 ? "" : "s"}`;
  const outcome = rollupTests(summary.tests);
  if (files && outcome === "pass") return `${files} and the tests passed.`;
  if (files && outcome === "fail") return `${files}, and the tests failed.`;
  if (files) return `${files}.`;
  if (outcome === "pass") return "The tests passed.";
  if (outcome === "fail") return "The tests failed.";
  return "The session is ready for review.";
}

function scrubCommandPiece(piece: string, options: RedactOptions): string {
  let rest = piece.trim();
  const kept: string[] = [];
  const env = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S+))\s*/;
  let match = env.exec(rest);
  while (match) {
    const key = match[1] ?? "";
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (!sentenceHasSecret(`${key}=${value}`, options)) kept.push(`${key}=${value}`);
    rest = rest.slice(match[0].length);
    match = env.exec(rest);
  }
  const words = rest.split(/\s+/).filter((word) => word && !sentenceHasSecret(word, options));
  return [...kept, ...words].join(" ").trim();
}

function scrubPiece(text: string, options: RedactOptions): string {
  const stripped = stripPrivatePaths(text).replace(/^\/+/, "");
  if (!stripped || sentenceHasSecret(stripped, options)) return "";
  return oneLine(stripped);
}

function scrubEvent(event: TimelineEvent, options: RedactOptions): TimelineEvent | undefined {
  if (event.kind === "read") {
    const path = event.path ? scrubPiece(event.path, options) : "";
    return { kind: "read", path: path || undefined };
  }
  if (event.kind === "edit") {
    const path = scrubPiece(event.path, options);
    if (!path) return undefined;
    return { kind: "edit", path, action: event.action };
  }
  if (event.kind === "test") {
    const command = scrubCommand(event.command, options);
    if (!command) return undefined;
    return { ...event, command };
  }
  return event;
}

function publicCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const stripped = stripPrivatePaths(cwd).trim();
  return stripped || undefined;
}

function sentenceHasSecret(text: string, options: RedactOptions): boolean {
  return MARKER.test(redact(text, options));
}

function isOnlyEmail(text: string): boolean {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\.?$/.test(text.trim());
}

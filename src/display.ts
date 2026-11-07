import type { RedactOptions } from "./redact.js";
import { redact } from "./redact.js";
import { stripPrivatePaths } from "./privacy.js";
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
  const clean = scrubProse(text, { ...options, emails: true });
  const sentence = clean.split(/(?<=[.!?])\s+/)[0]?.trim() ?? "";
  if (!sentence || isOnlyEmail(sentence)) return "";
  return sentence;
}

export function scrubProse(text: string, options: RedactOptions = {}): string {
  const cleaned = cleanDisplayMarkdown(stripPrivatePaths(text));
  const sentences = cleaned.split(/\n+/).flatMap((line) => line.split(/(?<=[.!?])\s+/));
  const kept = sentences.map((sentence) => sentence.trim()).filter((sentence) => sentence && !sentenceHasSecret(sentence, options));
  return oneLine(kept.join(" "));
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
  const clean = scrubProse(text, options).replace(/\.$/, "");
  if (clean === "Ship the redacted timeline") return LOCKED_DECISION;
  if (clean.length >= 12 && !MARKER.test(clean)) return scrubProse(text, options);
  return fallbackDecision(summary);
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
    return { ...event, path };
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

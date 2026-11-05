import type { RedactOptions } from "./redact.js";
import { redact } from "./redact.js";
import { rollupTests, withSteps } from "./summary.js";
import type { SessionSummary } from "./types.js";
import { oneLine } from "./text.js";

const MARKER = /\[REDACTED_[A-Z0-9_]+\]/;

export interface Presented {
  summary: SessionSummary;
  /** True when a secret was removed from a string a reviewer might read. */
  secretsStripped: boolean;
  /** How many secret spans were removed. Drives `masked ×N` and nothing else. */
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

  const title = scrubTitle(input.title, options);
  const decision = scrubDecision(input.decision, input, options);
  const files = input.files
    .map((file) => ({ ...file, path: scrubPiece(file.path, options) }))
    .filter((file) => file.path.length > 0);
  const tests = input.tests
    .map((test) => ({ ...test, command: scrubCommand(test.command, options) }))
    .filter((test) => test.command.length > 0);

  return {
    secretsStripped,
    maskedCount,
    summary: withSteps({
      ...input,
      title: title || "Coding-agent session",
      decision,
      files,
      tests,
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
  const sentences = text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/));
  const kept = sentences.map((sentence) => sentence.trim()).filter((sentence) => sentence && !sentenceHasSecret(sentence, options));
  return oneLine(kept.join(" "));
}

export function scrubCommand(command: string, options: RedactOptions = {}): string {
  const pieces = command.split(/\s*(?:&&|\|\||;)\s*/);
  const kept = pieces.map((piece) => scrubCommandPiece(piece, options)).filter((piece) => piece.length > 0);
  return oneLine(kept.join(" && "));
}

function scrubDecision(text: string, summary: SessionSummary, options: RedactOptions): string {
  const clean = scrubProse(text, options);
  if (clean.length >= 12 && !MARKER.test(clean)) return clean;
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
  if (sentenceHasSecret(text, options)) return "";
  return oneLine(text);
}

function sentenceHasSecret(text: string, options: RedactOptions): boolean {
  return MARKER.test(redact(text, options));
}

function isOnlyEmail(text: string): boolean {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\.?$/.test(text.trim());
}

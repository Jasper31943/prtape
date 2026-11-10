import type { SessionSummary, SourceKind, Step } from "../types.js";
import { rollupTests } from "../summary.js";
import { firstSentence, oneLine, truncate } from "../text.js";

export function sourceLabel(source: SourceKind): string {
  return source === "claude-code" ? "Claude Code" : "Aider";
}

/** `2026-11-01T15:04:22.000Z` → `2026-11-01 15:04 UTC`. Naive timestamps omit UTC. */
export function formatWhen(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(value);
  if (!match) return undefined;
  const utc = /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  return `${match[1]} ${match[2]}${utc ? " UTC" : ""}`;
}

export function filesDetail(summary: SessionSummary, maxNames = 3): string {
  if (summary.files.length === 0) return "No files edited";
  const names = summary.files.slice(0, maxNames).map((file) => file.path);
  const extra = summary.files.length - names.length;
  const listed = names.join(" · ");
  return extra > 0 ? `${listed} · +${extra}` : listed;
}

/**
 * Reviewer-facing test line.
 * When the first failure and the last run both published counts, show
 * `6 failed → 13/13 pass`. Otherwise the last command, such as `npm test · pass`.
 */
export function testsPhrase(summary: SessionSummary): string {
  const transition = testsTransition(summary);
  if (transition) return `${transition.failed} failed → ${transition.passed}/${transition.total} pass`;
  const last = summary.tests.at(-1);
  if (!last) return "not run";
  const word = last.outcome === "pass" ? "pass" : last.outcome === "fail" ? "fail" : "ran";
  const command = oneLine(last.command);
  return command ? `${command} · ${word}` : word;
}

export function testsTransition(summary: SessionSummary): { failed: number; passed: number; total: number } | undefined {
  const firstFail = summary.tests.find((test) => test.outcome === "fail" && typeof test.failed === "number" && test.failed > 0);
  const last = summary.tests.at(-1);
  if (!firstFail || last?.outcome !== "pass") return undefined;
  if (typeof last.passed !== "number" || typeof last.total !== "number") return undefined;
  if (!Number.isInteger(firstFail.failed) || !Number.isInteger(last.passed) || !Number.isInteger(last.total)) return undefined;
  return { failed: firstFail.failed as number, passed: last.passed, total: last.total };
}

export function publicSteps(steps: Step[]): Step[] {
  return steps.filter((step) => step.kind !== "read" || Boolean(step.path));
}

export function asciiFlow(summary: SessionSummary): string {
  const count = summary.files.length;
  const files = count === 0 ? "no file edits" : count === 1 ? "1 file" : `${count} files`;
  const outcome = rollupTests(summary.tests);
  const tests = !summary.testsRun
    ? "tests not run"
    : outcome === "pass"
      ? "tests pass"
      : outcome === "fail"
        ? "tests fail"
        : "tests ran";
  return `ask ──▶ ${files} ──▶ ${tests} ──▶ ship`;
}

export function footerLine(summary: SessionSummary): string {
  const count = summary.files.length;
  const files = count === 0 ? "no files touched" : `${count} file${count === 1 ? "" : "s"} touched`;
  const outcome = rollupTests(summary.tests);
  const tests = !summary.testsRun
    ? "tests not run"
    : outcome === "pass"
      ? "tests pass"
      : outcome === "fail"
        ? "tests fail"
        : "tests ran";
  return `${files}  ·  ${tests}  ·  redacted before posting`;
}

export function askLine(summary: SessionSummary, max = 80): string {
  return truncate(firstSentence(summary.title), max);
}

export function decisionLine(summary: SessionSummary, max = 90): string {
  return truncate(oneLine(summary.decision), max);
}

export function stepText(step: Step): string {
  switch (step.kind) {
    case "prompt":
      return `**Ask** — ${truncate(firstSentence(step.text), 180)}`;
    case "read":
      return step.path ? `**Read** — \`${step.path}\`` : "**Read**";
    case "edit": {
      const verb = step.action === "write" ? "Write" : step.action === "delete" ? "Delete" : "Edit";
      return `**${verb}** — \`${step.path}\``;
    }
    case "test":
      return `**Test** — \`${truncate(oneLine(step.command), 80)}\` · ${step.outcome}`;
    case "commit":
      return "**Commit**";
    case "decision":
      return `**Decision** — ${truncate(oneLine(step.text), 500)}`;
    default: {
      const never: never = step;
      return never;
    }
  }
}

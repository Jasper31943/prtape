import type { SessionDraft, SessionSummary, Step, TestOutcome, TestRun } from "./types.js";
import { FALLBACK_DECISION, FALLBACK_TITLE } from "./types.js";

const FILE_RANK = { edit: 1, delete: 2, write: 3 } as const;

export function withSteps(draft: SessionDraft): SessionSummary {
  const title = draft.title.trim() || FALLBACK_TITLE;
  const decision = draft.decision.trim() || FALLBACK_DECISION;
  const steps: Step[] = [
    { kind: "prompt", text: title },
    ...draft.files.map((file) => ({ kind: "edit" as const, path: file.path, action: file.action })),
    ...draft.tests.map((test) => ({ kind: "test" as const, command: test.command, outcome: test.outcome })),
    { kind: "decision", text: decision },
  ];
  return {
    ...draft,
    title,
    decision,
    testsRun: draft.tests.length > 0,
    steps,
  };
}

export function addFile(
  files: SessionDraft["files"],
  filePath: string,
  action: SessionDraft["files"][number]["action"],
): void {
  const existing = files.find((file) => file.path === filePath);
  if (!existing) {
    files.push({ path: filePath, action });
    return;
  }
  if (FILE_RANK[action] > FILE_RANK[existing.action]) {
    existing.action = action;
  }
}

/** Keep every run, in order, so a later pass does not erase the earlier failure. */
export function addTest(tests: TestRun[], command: string, outcome: TestOutcome): void {
  const key = command.trim();
  if (!key) return;
  tests.push({ command: key, outcome });
}

export function sessionIsEmpty(summary: SessionSummary): boolean {
  return (
    summary.title === FALLBACK_TITLE &&
    summary.decision === FALLBACK_DECISION &&
    summary.files.length === 0 &&
    summary.tests.length === 0
  );
}

export function rollupTests(tests: TestRun[]): "pass" | "fail" | "unknown" | "none" {
  const last = tests.at(-1);
  if (!last) return "none";
  return last.outcome;
}

export function sawFailureThenPass(tests: TestRun[]): boolean {
  let failed = false;
  for (const test of tests) {
    if (test.outcome === "fail") failed = true;
    else if (failed && test.outcome === "pass") return true;
  }
  return false;
}

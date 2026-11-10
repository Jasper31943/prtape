import { displayTestCommand } from "./tests-detect.js";
import type { SessionDraft, SessionSummary, Step, TestOutcome, TestRun, TimelineEvent } from "./types.js";
import { FALLBACK_DECISION, FALLBACK_TITLE } from "./types.js";

const FILE_RANK = { edit: 1, delete: 2, write: 3 } as const;

export function withSteps(draft: SessionDraft): SessionSummary {
  const title = draft.title.trim() || FALLBACK_TITLE;
  const decision = draft.decision.trim() || FALLBACK_DECISION;
  const events = collapseIdenticalFails(draft.events ?? bucketEvents(draft.files, draft.tests));
  const files = draft.events ? filesFrom(events) : draft.files;
  const tests = draft.events ? testsFrom(events) : draft.tests;
  const steps: Step[] = [
    { kind: "prompt", text: title },
    ...events.map((event) => eventStep(event)),
    { kind: "decision", text: decision },
  ];
  return {
    ...draft,
    title,
    decision,
    files,
    tests,
    events,
    testsRun: tests.length > 0,
    steps,
  };
}

/**
 * Drop a second record of the same failing command.
 * Adjacent duplicates are one tool call stored twice.
 * A failing test bundled with the inspection reads that follow an earlier
 * failure of that same command is the same run, not a new attempt.
 * A later failure after a separate read stays.
 */
function collapseIdenticalFails(events: TimelineEvent[]): TimelineEvent[] {
  const kept: TimelineEvent[] = [];
  for (const event of events) {
    if (isDuplicateFail(kept, event)) continue;
    kept.push(event);
  }
  return kept;
}

function isDuplicateFail(kept: TimelineEvent[], event: TimelineEvent): boolean {
  if (event.kind !== "test" || event.outcome !== "fail") return false;
  const command = displayTestCommand(event.command);
  if (!command) return false;
  const previous = kept.at(-1);
  if (previous?.kind === "test" && previous.outcome === "fail" && displayTestCommand(previous.command) === command) {
    return true;
  }
  if (!event.batch) return false;
  let index = kept.length - 1;
  while (index >= 0 && kept[index]?.kind === "read" && kept[index]?.batch === event.batch) index -= 1;
  if (index === kept.length - 1) return false;
  const earlier = kept[index];
  return earlier?.kind === "test" && earlier.outcome === "fail" && displayTestCommand(earlier.command) === command;
}

/** Files then tests. Used when a parser has no interleaved event list. */
function bucketEvents(files: SessionDraft["files"], tests: TestRun[]): TimelineEvent[] {
  return [
    ...files.map((file) => ({ kind: "edit" as const, path: file.path, action: file.action })),
    ...tests.map((test) => ({ kind: "test" as const, command: test.command, outcome: test.outcome })),
  ];
}

function filesFrom(events: TimelineEvent[]): SessionDraft["files"] {
  const files: SessionDraft["files"] = [];
  for (const event of events) {
    if (event.kind === "edit") addFile(files, event.path, event.action);
  }
  return files;
}

function testsFrom(events: TimelineEvent[]): TestRun[] {
  return events
    .filter((event): event is Extract<TimelineEvent, { kind: "test" }> => event.kind === "test")
    .map((event) => ({ command: event.command, outcome: event.outcome }));
}

function eventStep(event: TimelineEvent): Step {
  switch (event.kind) {
    case "read":
      return { kind: "read", path: event.path };
    case "edit":
      return { kind: "edit", path: event.path, action: event.action };
    case "test":
      return { kind: "test", command: event.command, outcome: event.outcome };
    case "commit":
      return { kind: "commit" };
    default: {
      const never: never = event;
      return never;
    }
  }
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


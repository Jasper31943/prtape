export type SourceKind = "claude-code" | "aider";

export type FileAction = "edit" | "write" | "delete";

export type TestOutcome = "pass" | "fail" | "unknown";

export interface TouchedFile {
  path: string;
  action: FileAction;
}

export interface TestRun {
  command: string;
  outcome: TestOutcome;
  /** Parsed from that run's reporter. Absent when the output has no counts. */
  failed?: number;
  passed?: number;
  total?: number;
  /** First failing test name, copied from the reporter line. */
  failedName?: string;
}

/** One observed action, in the order it happened. Not a canned phase. */
export type TimelineEvent = (
  | { kind: "read"; path?: string }
  | { kind: "edit"; path: string; action: FileAction; before?: string; after?: string }
  | {
      kind: "test";
      command: string;
      outcome: TestOutcome;
      failed?: number;
      passed?: number;
      total?: number;
      failedName?: string;
    }
  | { kind: "commit"; message?: string }
) & {
  /** Bash tool call that produced this event. Not shown on public steps. */
  batch?: string;
};

export type Step =
  | { kind: "prompt"; text: string }
  | { kind: "read"; path?: string }
  | { kind: "edit"; path: string; action: FileAction }
  | { kind: "test"; command: string; outcome: TestOutcome }
  | { kind: "commit" }
  | { kind: "decision"; text: string };

/** Used when a session file has no human prompt. */
export const FALLBACK_TITLE = "Coding-agent session";

/** Used when a session file has no summary and no assistant prose. */
export const FALLBACK_DECISION = "Session recorded. No decision summary was found.";

export interface SessionSummary {
  source: SourceKind;
  sessionId: string;
  startedAt?: string;
  model?: string;
  branch?: string;
  cwd?: string;
  title: string;
  decision: string;
  files: TouchedFile[];
  tests: TestRun[];
  /** Observed actions in session order. Drives steps and the track. */
  events: TimelineEvent[];
  testsRun: boolean;
  steps: Step[];
}

export interface SessionDraft {
  source: SourceKind;
  sessionId: string;
  startedAt?: string;
  model?: string;
  branch?: string;
  cwd?: string;
  title: string;
  decision: string;
  files: TouchedFile[];
  tests: TestRun[];
  /** When set, this order wins over files-then-tests bucketing. */
  events?: TimelineEvent[];
}

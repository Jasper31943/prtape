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
}

export type Step =
  | { kind: "prompt"; text: string }
  | { kind: "edit"; path: string; action: FileAction }
  | { kind: "test"; command: string; outcome: TestOutcome }
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
}

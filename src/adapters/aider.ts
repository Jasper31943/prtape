import type { SessionSummary, TestOutcome } from "../types.js";
import { FALLBACK_DECISION, FALLBACK_TITLE } from "../types.js";
import { addFile, addTest, withSteps } from "../summary.js";
import { classifyTestOutput, isTestCommand } from "../tests-detect.js";
import { oneLine } from "../text.js";

/**
 * Aider chat history (`.aider.chat.history.md`).
 *
 * Assumed grammar, from Aider's own history writer and public notes
 * (Aider issue #916, and later readers such as deja and lcc):
 *
 * - `# aider chat started at YYYY-MM-DD HH:MM:SS` starts a session.
 *   One file holds many sessions. The timeline uses the last one.
 * - `#### ` lines are user prompts (outside fenced code blocks).
 * - `> ` lines are Aider tool or UI output.
 * - Other lines are assistant prose, including SEARCH/REPLACE edits.
 * - `> Applied edit to <file>` is a file that was actually written.
 * - `> Running <cmd>`, `/run`, `/test`, and `!cmd` are shell commands.
 *   `> Added <file> to the chat` is context, not an edit.
 *
 * Fenced code blocks (``` or ~~~) are assistant text. Markers inside them
 * are not prompts or tool lines. Diff bodies are not copied into the timeline.
 */
interface AiderSession {
  startedAt?: string;
  model?: string;
  prompts: string[];
  assistant: string[];
  files: SessionSummary["files"];
  tests: SessionSummary["tests"];
}

export function parseAider(text: string, fallbackId = "aider-session"): SessionSummary {
  const sessions = splitSessions(text);
  const session = sessions.at(-1) ?? emptySession();
  const title = session.prompts[0] ? oneLine(session.prompts[0]) : FALLBACK_TITLE;
  const decision = oneLine(decisionFrom(session.assistant) || FALLBACK_DECISION);
  const startedAt = session.startedAt ? session.startedAt.replace(" ", "T") : undefined;

  return withSteps({
    source: "aider",
    sessionId: startedAt ? `aider-${startedAt.replace(/:/g, "-")}` : fallbackId,
    startedAt,
    model: session.model,
    title,
    decision,
    files: session.files,
    tests: session.tests,
  });
}

function emptySession(): AiderSession {
  return { prompts: [], assistant: [], files: [], tests: [] };
}

function splitSessions(text: string): AiderSession[] {
  const sessions: AiderSession[] = [];
  let current = emptySession();
  let sawHeader = false;
  let fence: "```" | "~~~" | null = null;
  let assistant: string[] = [];
  let tool: string[] = [];
  let pendingCommand: string | undefined;

  const flushAssistant = () => {
    const chunk = assistant.join("\n").trim();
    if (chunk) current.assistant.push(chunk);
    assistant = [];
  };
  const flushTool = () => {
    if (tool.length === 0 && !pendingCommand) return;
    absorbTool(current, tool, pendingCommand);
    tool = [];
    pendingCommand = undefined;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const fenceMark = fenceMarker(rawLine, fence);
    if (!fence && fenceMark) {
      flushTool();
      fence = fenceMark;
      assistant.push(rawLine);
      continue;
    }
    if (fence) {
      assistant.push(rawLine);
      if (fenceMark === fence && rawLine.trim().startsWith(fence)) fence = null;
      continue;
    }

    const header = /^# aider chat started at\s+(.+?)\s*$/.exec(rawLine);
    if (header) {
      flushAssistant();
      flushTool();
      if (sawHeader || sessionHasBody(current)) sessions.push(current);
      current = emptySession();
      current.startedAt = header[1]?.trim();
      sawHeader = true;
      continue;
    }

    if (rawLine.startsWith("####")) {
      flushAssistant();
      flushTool();
      const body = rawLine.replace(/^####\s?/, "").trim();
      const parsed = parseUserLine(body);
      if (parsed.kind === "prompt" && parsed.text) current.prompts.push(parsed.text);
      if (parsed.kind === "command") pendingCommand = parsed.text;
      continue;
    }

    if (rawLine.startsWith(">")) {
      flushAssistant();
      const body = rawLine.replace(/^>\s?/, "");
      tool.push(body);
      const model = /^Model:\s*(\S+)/.exec(body.trim());
      if (model?.[1]) current.model = model[1];
      continue;
    }

    // A blank line sits between `/run` and the following `>` block.
    // Keep the pending command; only close a tool block that already started.
    if (!rawLine.trim()) {
      if (tool.length > 0) flushTool();
      else if (!pendingCommand) assistant.push(rawLine);
      continue;
    }

    if (tool.length > 0 || pendingCommand) flushTool();
    assistant.push(rawLine);
  }

  flushAssistant();
  flushTool();
  if (sawHeader || sessionHasBody(current)) sessions.push(current);
  return sessions.filter(sessionHasBody);
}

function sessionHasBody(session: AiderSession): boolean {
  return (
    session.prompts.length > 0 ||
    session.assistant.length > 0 ||
    session.files.length > 0 ||
    session.tests.length > 0
  );
}

function fenceMarker(line: string, open: "```" | "~~~" | null): "```" | "~~~" | null {
  const trimmed = line.trim();
  if (open) return trimmed.startsWith(open) ? open : null;
  if (trimmed.startsWith("```")) return "```";
  if (trimmed.startsWith("~~~")) return "~~~";
  return null;
}

function parseUserLine(text: string): { kind: "prompt" | "command" | "ignore"; text: string } {
  const run = /^(?:\/run|\/test|!)\s+(.+)$/i.exec(text);
  if (run?.[1]) return { kind: "command", text: run[1].trim() };
  if (/^\/[A-Za-z]/.test(text)) return { kind: "ignore", text };
  return { kind: "prompt", text };
}

function absorbTool(session: AiderSession, lines: string[], pendingCommand: string | undefined): void {
  let command = pendingCommand;
  const output: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const edit = /^Applied edit to\s+`?(.+?)`?\s*$/.exec(trimmed);
    if (edit?.[1]) {
      addFile(session.files, edit[1].trim(), "edit");
      continue;
    }
    const running = /^Running\s+(.+)$/.exec(trimmed);
    if (running?.[1]) {
      command = running[1].trim();
      continue;
    }
    if (trimmed) output.push(trimmed);
  }
  if (!command || !isTestCommand(command)) return;
  const outcome: TestOutcome = classifyTestOutput(output.join("\n"), false, false);
  addTest(session.tests, command, outcome);
}

function decisionFrom(chunks: string[]): string {
  const prose = chunks
    .map(stripDiffs)
    .flatMap((chunk) => chunk.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("```") && !line.startsWith("~~~"))
    .filter((line) => !/^<{3,}|^={3,}|>{3,}/.test(line));
  return prose.at(-1) ?? "";
}

function stripDiffs(chunk: string): string {
  return chunk
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/~~~[\s\S]*?~~~/g, "\n")
    .replace(/^[^\n]+\n<<<<<<< SEARCH[\s\S]*?>>>>>>> REPLACE\n?/gm, "\n");
}

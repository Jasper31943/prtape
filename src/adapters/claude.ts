import path from "node:path";
import type { SessionSummary, TestOutcome } from "../types.js";
import { FALLBACK_DECISION, FALLBACK_TITLE } from "../types.js";
import { bashFileEdits } from "../bash-edits.js";
import { isScratchPath } from "../privacy.js";
import { addFile, addTest, withSteps } from "../summary.js";
import { classifyTestOutput, isTestCommand } from "../tests-detect.js";
import { oneLine } from "../text.js";

/**
 * Claude Code session JSONL.
 *
 * Assumed schema, from public descriptions of Claude Code 2.x transcripts
 * (PromptConduit, bough, and the clog SOURCE_FORMATS notes, observed 2026).
 * Claude Code does not publish a stable contract. This parser skips unknown
 * fields, unknown record types, and lines that are not JSON.
 *
 * Layout:
 *   ~/.claude/projects/<slug>/<session-uuid>.jsonl
 * `<slug>` replaces ":", "\", and "/" in the project path with "-". That
 * encoding is lossy, so discovery prefers the `cwd` field over the directory
 * name. Only top-level `*.jsonl` files are sessions. Files under
 * `<session>/subagents/` are not.
 *
 * Each line is one object. Records form a tree via `uuid` / `parentUuid`.
 * Rewinds leave abandoned branches in the same file, so the timeline follows
 * the newest leaf back to the root. If parent links are missing, the file
 * order is used instead.
 *
 * Records we understand:
 * - `user` with a string `message.content` — a human prompt.
 *   `isMeta` prompts are ignored (they are system reminders).
 * - `user` with `tool_result` blocks — outcomes, matched by `tool_use_id`.
 * - `assistant` content blocks `text` and `tool_use`. `thinking` is never
 *   copied into the timeline.
 * - `summary` — `{ summary, leafUuid }`, preferred one-line decision.
 *
 * Tool inputs differ across releases. File tools may use `file_path`, `path`,
 * or `notebook_path`. Bash may use `command` or `cmd`. Streaming repeats of
 * the same tool id are counted once.
 */
interface ClaudeRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  summary?: string;
  leafUuid?: string;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
  };
  toolUseResult?: unknown;
}

const FILE_EDIT_TOOLS = new Set([
  "edit",
  "multiedit",
  "strreplace",
  "notebookedit",
  "search_replace",
]);
const FILE_WRITE_TOOLS = new Set(["write", "create", "notebookwrite"]);
const FILE_DELETE_TOOLS = new Set(["delete", "remove"]);

export function parseClaude(text: string, fallbackId = "claude-session"): SessionSummary {
  const records = parseLines(text);
  const active = activeRecords(records);
  const activeIds = new Set(active.map((record) => record.uuid).filter((id): id is string => Boolean(id)));

  const cwd = firstString(active, "cwd") ?? firstString(records, "cwd");
  const branch = firstString(active, "gitBranch") ?? firstString(records, "gitBranch");
  const sessionId = firstString(active, "sessionId") ?? firstString(records, "sessionId") ?? fallbackId.replace(/\.jsonl$/, "");
  const startedAt = firstString(active, "timestamp");
  const model = firstModel(active);

  const prompts: string[] = [];
  const files: SessionSummary["files"] = [];
  const tests: SessionSummary["tests"] = [];
  const assistantLines: string[] = [];
  const toolUses = new Map<string, { name: string; command?: string }>();

  for (const record of active) {
    if (record.isSidechain || record.isMeta) continue;
    if (record.type === "user") {
      const prompt = humanPrompt(record);
      if (prompt) prompts.push(prompt);
    }
    if (record.type === "assistant") {
      for (const block of contentBlocks(record.message?.content)) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          assistantLines.push(block.text.trim());
        }
        if (block.type !== "tool_use") continue;
        const id = typeof block.id === "string" ? block.id : undefined;
        const name = typeof block.name === "string" ? block.name : "";
        const input = isRecord(block.input) ? block.input : {};
        if (id && toolUses.has(id)) continue;
        const command = bashCommand(name, input);
        if (id) toolUses.set(id, { name, command });
        collectFileTouch(files, name, input, cwd);
        if (command) collectBashEdits(files, command, cwd);
      }
    }
  }

  const results = collectToolResults(records);
  for (const [id, tool] of toolUses) {
    const command = tool.command;
    if (!command || !isTestCommand(command)) continue;
    const result = results.get(id);
    const outcome: TestOutcome = result
      ? classifyTestOutput(result.text, result.isError, result.interrupted)
      : "unknown";
    addTest(tests, command, outcome);
  }

  const summaryText = pickSummary(records, activeIds);
  const title = prompts[0] ? oneLine(prompts[0]) : FALLBACK_TITLE;
  const decision = oneLine(summaryText || assistantLines.at(-1) || FALLBACK_DECISION);

  return withSteps({
    source: "claude-code",
    sessionId,
    startedAt,
    model,
    branch,
    cwd,
    title,
    decision,
    files,
    tests,
  });
}

function parseLines(text: string): ClaudeRecord[] {
  const records: ClaudeRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (isRecord(value)) records.push(value as ClaudeRecord);
    } catch {
      // Broken lines are ignored. Claude Code has changed this file before.
    }
  }
  return records;
}

function activeRecords(records: ClaudeRecord[]): ClaudeRecord[] {
  const withId = records.filter((record) => typeof record.uuid === "string" && record.uuid.length > 0);
  if (withId.length === 0) return records;

  const byId = new Map<string, ClaudeRecord>();
  const childCount = new Map<string, number>();
  for (const record of withId) {
    byId.set(record.uuid as string, record);
  }
  for (const record of withId) {
    const parent = record.parentUuid;
    if (typeof parent === "string" && byId.has(parent)) {
      childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
    }
  }

  const leaves = withId.filter((record) => (childCount.get(record.uuid as string) ?? 0) === 0);
  leaves.sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")));
  const leaf = leaves[0];
  if (!leaf?.uuid) return records;

  const pathRecords: ClaudeRecord[] = [];
  const seen = new Set<string>();
  let current: ClaudeRecord | undefined = leaf;
  while (current?.uuid && !seen.has(current.uuid)) {
    pathRecords.push(current);
    seen.add(current.uuid);
    const parent: string | null | undefined = current.parentUuid;
    current = typeof parent === "string" ? byId.get(parent) : undefined;
  }
  pathRecords.reverse();

  // A broken parent chain would otherwise keep only the leaf.
  if (pathRecords.length <= 1 && records.length > 2) return records;
  return pathRecords;
}

function pickSummary(records: ClaudeRecord[], activeIds: Set<string>): string | undefined {
  const summaries = records.filter(
    (record) => record.type === "summary" && typeof record.summary === "string" && record.summary.trim(),
  );
  const linked = summaries.find(
    (record) => typeof record.leafUuid === "string" && activeIds.has(record.leafUuid),
  );
  const chosen = linked ?? summaries.at(-1);
  return chosen?.summary?.trim();
}

function humanPrompt(record: ClaudeRecord): string | undefined {
  const content = record.message?.content;
  if (typeof content !== "string") return undefined;
  const text = content.trim();
  return text || undefined;
}

interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

function contentBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord) as ContentBlock[];
}

function collectBashEdits(
  files: SessionSummary["files"],
  command: string,
  cwd: string | undefined,
): void {
  for (const edit of bashFileEdits(command)) {
    const display = displayPath(edit.path, cwd);
    if (!display || isScratchPath(edit.path) || isScratchPath(display)) continue;
    addFile(files, display, edit.action);
  }
}

function collectFileTouch(
  files: SessionSummary["files"],
  name: string,
  input: Record<string, unknown>,
  cwd: string | undefined,
): void {
  const tool = name.toLowerCase();
  const filePath = toolFilePath(input);
  if (!filePath) return;
  const display = displayPath(filePath, cwd);
  if (FILE_WRITE_TOOLS.has(tool)) addFile(files, display, "write");
  else if (FILE_DELETE_TOOLS.has(tool)) addFile(files, display, "delete");
  else if (FILE_EDIT_TOOLS.has(tool)) addFile(files, display, "edit");
}

function toolFilePath(input: Record<string, unknown>): string | undefined {
  for (const key of ["file_path", "path", "notebook_path", "target_notebook", "filePath"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function bashCommand(name: string, input: Record<string, unknown>): string | undefined {
  if (name.toLowerCase() !== "bash") return undefined;
  for (const key of ["command", "cmd"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

interface ToolResult {
  text: string;
  isError: boolean;
  interrupted: boolean;
}

function collectToolResults(records: ClaudeRecord[]): Map<string, ToolResult> {
  const results = new Map<string, ToolResult>();
  for (const record of records) {
    if (record.isSidechain) continue;
    for (const block of contentBlocks(record.message?.content)) {
      if (block.type !== "tool_result") continue;
      const id = stringOf(block, "tool_use_id");
      if (!id || results.has(id)) continue;
      const structured = structuredResult(record.toolUseResult);
      const text = textOf((block as { content?: unknown }).content) || structured.text;
      results.set(id, {
        text,
        isError: Boolean((block as { is_error?: unknown }).is_error) || structured.interrupted,
        interrupted: structured.interrupted,
      });
    }
  }
  return results;
}

function structuredResult(value: unknown): { text: string; interrupted: boolean } {
  if (!isRecord(value)) return { text: "", interrupted: false };
  const stdout = typeof value.stdout === "string" ? value.stdout : "";
  const stderr = typeof value.stderr === "string" ? value.stderr : "";
  return {
    text: [stdout, stderr].filter(Boolean).join("\n"),
    interrupted: value.interrupted === true,
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .join("\n");
}

function displayPath(filePath: string, cwd: string | undefined): string {
  let out = filePath;
  if (cwd && path.isAbsolute(filePath)) {
    const relative = path.relative(cwd, filePath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      out = relative;
    }
  }
  return out.split(path.sep).join("/");
}

function firstString(records: ClaudeRecord[], key: "cwd" | "gitBranch" | "sessionId" | "timestamp"): string | undefined {
  for (const record of records) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function firstModel(records: ClaudeRecord[]): string | undefined {
  for (const record of records) {
    const model = record.message?.model;
    if (typeof model === "string" && model.trim()) return model.trim();
  }
  return undefined;
}

function stringOf(value: object, key: string): string | undefined {
  const record = value as Record<string, unknown>;
  const found = record[key];
  return typeof found === "string" && found.trim() ? found : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

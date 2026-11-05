import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAider } from "./adapters/aider.js";
import { parseClaude } from "./adapters/claude.js";
import {
  defaultClaudeHome,
  findSession,
  NoSessionError,
  type DiscoverOptions,
  type SourceChoice,
} from "./discover.js";
import { GhError, postComment, type CommandRunner } from "./gh.js";
import { redactSession, type RedactOptions } from "./redact.js";
import { sessionIsEmpty } from "./summary.js";
import { renderComment, terminalSummary } from "./timeline/md.js";
import { renderSvg } from "./timeline/svg.js";
import type { SessionSummary, SourceKind } from "./types.js";
import { VERSION } from "./version.js";

export interface RunOptions {
  cwd: string;
  sessionPath?: string;
  source: SourceChoice;
  claudeHome?: string;
  dryRun: boolean;
  redactEmails: boolean;
  tmpDir?: string;
  runner?: CommandRunner;
  recentFiles?: string[];
}

export interface RunResult {
  summary: SessionSummary;
  comment: string;
  svg: string;
  svgPath: string;
  posted: boolean;
  note: string;
  sessionNote?: string;
  prNumber?: number;
  prUrl?: string;
  origin: string;
}

export function toPublicJson(summary: SessionSummary): unknown {
  return {
    version: VERSION,
    source: summary.source,
    sessionId: summary.sessionId,
    startedAt: summary.startedAt ?? null,
    model: summary.model ?? null,
    branch: summary.branch ?? null,
    cwd: summary.cwd ?? null,
    title: summary.title,
    decision: summary.decision,
    testsRun: summary.testsRun,
    tests: summary.tests,
    files: summary.files,
    steps: summary.steps,
  };
}

export async function runPr(options: RunOptions): Promise<RunResult> {
  const cwd = path.resolve(options.cwd);
  const found = locate(options, cwd);
  const raw = readSession(found.path);
  const summary = parseFound(found.source, found.path, raw);
  if (!summary.branch) {
    const branch = gitBranch(cwd);
    if (branch) summary.branch = branch;
  }
  if (sessionIsEmpty(summary)) {
    throw new NoSessionError(`Nothing to timeline in ${found.path}. No prompt, edit, test, or summary was recognized.`);
  }

  const redactOptions: RedactOptions = { emails: options.redactEmails };
  const redacted = redactSession(summary, redactOptions);
  const comment = renderComment(redacted, redactOptions);
  const svg = renderSvg(redacted, redactOptions);
  const svgPath = writeTimelineSvg(svg, cwd, redacted.sessionId, options.tmpDir ?? os.tmpdir());

  const base = {
    summary: redacted,
    comment,
    svg,
    svgPath,
    sessionNote: found.note,
    origin: found.path,
  };

  if (options.dryRun) {
    return {
      ...base,
      posted: false,
      note: "AgentTape dry-run. Nothing was posted.",
    };
  }

  try {
    const pr = await postComment(cwd, comment, options.runner);
    return {
      ...base,
      posted: true,
      note: `Commented on PR #${pr.number}.`,
      prNumber: pr.number,
      prUrl: pr.url || undefined,
    };
  } catch (error) {
    const reason = error instanceof GhError ? error.message : "Could not post the comment.";
    return {
      ...base,
      posted: false,
      note: `${reason} Nothing was posted.`,
    };
  }
}

export function formatPosted(result: RunResult): string {
  const lines = [result.note];
  if (result.prUrl) lines.push(result.prUrl);
  lines.push(`SVG: ${result.svgPath}`);
  lines.push("");
  lines.push(terminalSummary(result.summary));
  return `${lines.join("\n")}\n`;
}

function locate(options: RunOptions, cwd: string): { source: SourceKind; path: string; note?: string } {
  if (options.sessionPath) {
    const file = path.resolve(options.sessionPath);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new NoSessionError(`Session file not found: ${file}`);
    }
    const sample = fs.readFileSync(file, "utf8");
    return { source: detectSource(file, sample, options.source), path: file };
  }
  const discover: DiscoverOptions = {
    cwd,
    source: options.source,
    claudeHome: options.claudeHome ?? defaultClaudeHome(),
    recentFiles: options.recentFiles,
  };
  return findSession(discover);
}

function detectSource(file: string, text: string, forced: SourceChoice): SourceKind {
  if (forced === "claude") return "claude-code";
  if (forced === "aider") return "aider";
  if (file.endsWith(".jsonl")) return "claude-code";
  if (file.endsWith(".md")) return "aider";
  return text.trimStart().startsWith("{") ? "claude-code" : "aider";
}

function parseFound(source: SourceKind, file: string, raw: string): SessionSummary {
  const base = path.basename(file);
  return source === "aider" ? parseAider(raw, base) : parseClaude(raw, base);
}

function readSession(file: string): string {
  return fs.readFileSync(file, "utf8");
}

export function writeTimelineSvg(svg: string, cwd: string, sessionId: string, tmpDir: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 48) || "session";
  const file = path.join(tmpDir, `agenttape-${safe}.svg`);
  assertNotInsideProject(file, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, svg, { encoding: "utf8", mode: 0o600 });
  return file;
}

export function assertNotInsideProject(target: string, cwd: string): void {
  const file = path.resolve(target);
  const root = path.resolve(cwd);
  const relative = path.relative(root, file);
  const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (inside) {
    throw new Error(`Refusing to write the timeline inside the project tree (${file}).`);
  }
}

function gitBranch(cwd: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const name = result.stdout.trim();
  if (!name || name === "HEAD") return undefined;
  return name;
}

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseClaude } from "./adapters/claude.js";
import type { SourceKind } from "./types.js";

export type SourceChoice = "auto" | "claude" | "aider";

export interface DiscoverOptions {
  cwd: string;
  source: SourceChoice;
  claudeHome: string;
  /** Injected so tests do not need a git repository. */
  recentFiles?: string[];
}

export interface FoundSession {
  source: SourceKind;
  path: string;
  note?: string;
}

export class NoSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoSessionError";
  }
}

/** Claude config dir. `CLAUDE_CONFIG_DIR` is honored when set; otherwise `~/.claude`. */
export function defaultClaudeHome(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
}

/**
 * Directory slug Claude Code uses under `projects/`.
 * Replaces ":", "\", and "/" with "-". The encoding is lossy when the path
 * itself contains dashes, so selection still reads the `cwd` field.
 */
export function claudeProjectSlug(cwd: string): string {
  return path.resolve(cwd).replace(/[:\\/]/g, "-");
}

export function pathsRelated(leftPath: string, rightPath: string): boolean {
  const left = path.resolve(leftPath);
  const right = path.resolve(rightPath);
  return left === right || right.startsWith(`${left}${path.sep}`) || left.startsWith(`${right}${path.sep}`);
}

export function listClaudeSessions(claudeHome: string): string[] {
  const projects = path.join(claudeHome, "projects");
  if (!fs.existsSync(projects)) return [];
  const sessions: string[] = [];
  let slugs: fs.Dirent[];
  try {
    slugs = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const dir = path.join(projects, slug.name);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      sessions.push(path.join(dir, entry.name));
    }
  }
  return sessions;
}

/** Walk upward from `start` for `.aider.chat.history.md`. */
export function findAiderHistory(start: string): string | null {
  let dir = path.resolve(start);
  const root = path.parse(dir).root;
  const seen = new Set<string>();
  for (let depth = 0; depth < 32; depth += 1) {
    if (seen.has(dir)) return null;
    seen.add(dir);
    const candidate = path.join(dir, ".aider.chat.history.md");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
  return null;
}

export function selectClaudeSession(
  files: string[],
  targetCwd: string,
  recentFiles: string[] = [],
): string | null {
  const related: { file: string; mtime: number }[] = [];
  const others: { file: string; mtime: number }[] = [];
  for (const file of files) {
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const cwd = sniffCwd(file);
    if (cwd && pathsRelated(cwd, targetCwd)) related.push({ file, mtime });
    else others.push({ file, mtime });
  }
  if (related.length > 0) {
    related.sort((a, b) => b.mtime - a.mtime);
    return related[0]?.file ?? null;
  }

  others.sort((a, b) => b.mtime - a.mtime);
  let best: { file: string; score: number; mtime: number } | null = null;
  for (const candidate of others.slice(0, 8)) {
    let summary;
    try {
      summary = parseClaude(fs.readFileSync(candidate.file, "utf8"), path.basename(candidate.file));
    } catch {
      continue;
    }
    const score = overlapScore(summary.files.map((file) => file.path), targetCwd, recentFiles);
    if (score <= 0) continue;
    if (!best || score > best.score || (score === best.score && candidate.mtime > best.mtime)) {
      best = { file: candidate.file, score, mtime: candidate.mtime };
    }
  }
  return best?.file ?? null;
}

export function findSession(options: DiscoverOptions): FoundSession {
  const wantClaude = options.source !== "aider";
  const wantAider = options.source !== "claude";
  const recent = options.recentFiles ?? gitChangedFiles(options.cwd);
  const claude = wantClaude
    ? selectClaudeSession(listClaudeSessions(options.claudeHome), options.cwd, recent)
    : null;
  const aider = wantAider ? findAiderHistory(options.cwd) : null;

  if (options.source === "claude") {
    if (!claude) throw new NoSessionError(missingClaude(options.cwd));
    return { source: "claude-code", path: claude };
  }
  if (options.source === "aider") {
    if (!aider) throw new NoSessionError(missingAider(options.cwd));
    return { source: "aider", path: aider };
  }
  if (claude && aider) {
    const claudeNewer = fs.statSync(claude).mtimeMs >= fs.statSync(aider).mtimeMs;
    return claudeNewer
      ? {
          source: "claude-code",
          path: claude,
          note: "Using the Claude Code session because it is newer than .aider.chat.history.md.",
        }
      : {
          source: "aider",
          path: aider,
          note: "Using Aider history because it is newer than the Claude Code session.",
        };
  }
  if (claude) return { source: "claude-code", path: claude };
  if (aider) return { source: "aider", path: aider };
  throw new NoSessionError(missingEither(options.cwd));
}

export function gitChangedFiles(cwd: string): string[] {
  const names = new Set<string>();
  for (const args of [
    ["diff", "--name-only", "HEAD"],
    ["diff", "--name-only", "--cached"],
    ["ls-files", "--others", "--exclude-standard"],
  ]) {
    for (const line of gitLines(cwd, args)) names.add(line);
  }
  return [...names];
}

function gitLines(cwd: string, args: string[]): string[] {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function overlapScore(paths: string[], targetCwd: string, recentFiles: string[]): number {
  if (recentFiles.length === 0) return 0;
  const root = path.resolve(targetCwd);
  let score = 0;
  for (const filePath of paths) {
    for (const changed of recentFiles) {
      const changedAbs = path.resolve(root, changed);
      const fileAbs = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
      if (filePath === changed || fileAbs === changedAbs || filePath.endsWith(`/${changed}`)) score += 1;
    }
  }
  return score;
}

/** Read `cwd` from the head of a session file. The first record normally carries it. */
export function sniffCwd(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(256 * 1024);
    const count = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, count).toString("utf8");
    const lines = text.split(/\r?\n/);
    if (count === buf.length) lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as { cwd?: unknown };
        if (typeof record.cwd === "string" && record.cwd.trim()) return record.cwd;
      } catch {
        // Keep scanning. Discovery must tolerate a bad line.
      }
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return undefined;
}

function missingClaude(cwd: string): string {
  return `No Claude Code session for ${cwd}. Looked under the Claude projects directory for a session whose cwd matches this directory, or that edited the files git currently shows as changed. Pass --session <file.jsonl> to choose one.`;
}

function missingAider(cwd: string): string {
  return `No .aider.chat.history.md in ${cwd} or its parents. Pass --session <file.md> to choose one.`;
}

function missingEither(cwd: string): string {
  return `No Claude Code session or Aider history for ${cwd}. Pass --session <file> to point at one. AgentTape does not read Cursor sessions in v0.1.`;
}

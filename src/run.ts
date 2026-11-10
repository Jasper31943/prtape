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
import { presentSummary } from "./display.js";
import { glanceRaster } from "./glance.js";
import { GhError, postComment, pullRequestHead, type CommandRunner } from "./gh.js";
import { hostTimelinePng, type HostResult } from "./orphan.js";
import { renderPng } from "./png.js";
import type { RedactOptions } from "./redact.js";
import { sessionIsEmpty } from "./summary.js";
import { renderComment, terminalSummary } from "./timeline/md.js";
import { publicSteps } from "./timeline/format.js";
import { renderSvg } from "./timeline/svg.js";
import type { SessionSummary, SourceKind } from "./types.js";
import { VERSION } from "./version.js";

export type ImageHost = (input: { cwd: string; png: Buffer }) => Promise<HostResult>;

export interface RunOptions {
  cwd: string;
  sessionPath?: string;
  source: SourceChoice;
  claudeHome?: string;
  dryRun: boolean;
  redactEmails: boolean;
  /** Comment on this pull request instead of the one for the current branch. */
  prNumber?: number;
  /** Show the Demo project tag. Off unless `--demo` or `--label demo` is set. */
  demo?: boolean;
  tmpDir?: string;
  runner?: CommandRunner;
  recentFiles?: string[];
  /** Test hook. Production uses `hostTimelinePng`. */
  hostImage?: ImageHost;
}

export interface RunResult {
  summary: SessionSummary;
  comment: string;
  svg: string;
  svgPath: string;
  pngPath?: string;
  posted: boolean;
  imageHosted: boolean;
  imageUrl?: string;
  note: string;
  sessionNote?: string;
  prNumber?: number;
  prUrl?: string;
  origin: string;
}

export function toPublicJson(
  summary: SessionSummary,
  image: { imageHosted: boolean; imageUrl?: string } = { imageHosted: false },
): unknown {
  return {
    version: VERSION,
    source: summary.source,
    startedAt: summary.startedAt ?? null,
    model: summary.model ?? null,
    branch: summary.branch ?? null,
    cwd: summary.cwd ?? null,
    title: summary.title,
    decision: summary.decision,
    testsRun: summary.testsRun,
    tests: summary.tests,
    files: summary.files,
    steps: publicSteps(summary.steps),
    imageHosted: image.imageHosted,
    imageUrl: image.imageUrl ?? null,
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
  if (!options.dryRun) {
    const head = await pullRequestHead(cwd, options.runner, options.prNumber);
    if (head) summary.branch = head;
  }
  if (sessionIsEmpty(summary)) {
    throw new NoSessionError(`Nothing to timeline in ${found.path}. No prompt, edit, test, or summary was recognized.`);
  }

  const redactOptions: RedactOptions = { emails: options.redactEmails };
  const view = presentSummary(summary, redactOptions);
  const shown = view.summary;
  const svg = renderSvg(summary, redactOptions, options.demo === true);
  const tmpDir = options.tmpDir ?? os.tmpdir();
  const svgPath = writeTimelineFile(svg, cwd, summary.sessionId, tmpDir, "svg");
  const raster = rasterize(svg);
  const pngPath = raster.png
    ? writeTimelineFile(raster.png, cwd, summary.sessionId, tmpDir, "png")
    : undefined;

  if (options.dryRun) {
    return {
      summary: shown,
      comment: pngPath
        ? renderComment(summary, redactOptions, { url: "timeline.png", isPrivate: false, dryRun: true }, options.demo === true)
        : renderComment(summary, redactOptions, undefined, options.demo === true),
      svg,
      svgPath,
      pngPath,
      posted: false,
      imageHosted: false,
      sessionNote: found.note,
      origin: found.path,
      note: [
        "PRtape dry-run. Nothing was posted and nothing was pushed.",
        "A real run pushes the PNG to refs/prtape/<head> and the comment leads with https://github.com/{owner}/{repo}/raw/{sha}/timeline.png.",
        "Logged-out viewers see that image on a public repo. On a private repo they may not.",
      ].join("\n"),
    };
  }

  const hosted = await resolveHost(options, cwd, raster);
  const comment = hosted.ok
    ? renderComment(summary, redactOptions, { url: hosted.url, isPrivate: hosted.isPrivate }, options.demo === true)
    : renderComment(summary, redactOptions, undefined, options.demo === true);
  const base = {
    summary: shown,
    comment,
    svg,
    svgPath,
    pngPath,
    sessionNote: found.note,
    origin: found.path,
    imageHosted: hosted.ok,
    imageUrl: hosted.ok ? hosted.url : undefined,
  };

  if (!hosted.ok && blocksComment(hosted.glance)) {
    return { ...base, posted: false, note: `${hosted.glance}\nNothing was posted.` };
  }

  try {
    const pr = await postComment(cwd, comment, options.runner, options.prNumber);
    if (!hosted.ok) {
      return {
        ...base,
        posted: true,
        prNumber: pr.number,
        prUrl: pr.url || undefined,
        note: `${hosted.glance}\n${pr.updated ? "Updated" : "Posted"} the text timeline on PR #${pr.number}. The PNG is not in the comment.`,
      };
    }
    return {
      ...base,
      posted: true,
      prNumber: pr.number,
      prUrl: pr.url || undefined,
      note: `${pr.updated ? "Updated" : "Commented on"} PR #${pr.number} with the hosted PNG.\n${hosted.url}`,
    };
  } catch (error) {
    const reason = error instanceof GhError ? error.message : "Could not post the comment.";
    const imageLine = hosted.ok
      ? `The PNG is on ${hosted.ref} at ${hosted.url}, but the comment was not posted.`
      : hosted.glance;
    return { ...base, posted: false, note: `${imageLine}\n${reason} Nothing was posted.` };
  }
}

function rasterize(svg: string): { png?: Buffer; glance?: string } {
  try {
    return { png: renderPng(svg) };
  } catch {
    return { glance: glanceRaster() };
  }
}

async function resolveHost(
  options: RunOptions,
  cwd: string,
  raster: { png?: Buffer; glance?: string },
): Promise<HostResult> {
  if (!raster.png) return { ok: false, glance: raster.glance ?? glanceRaster() };
  if (options.hostImage) return options.hostImage({ cwd, png: raster.png });
  return hostTimelinePng({ cwd, png: raster.png, runner: options.runner, tmpRoot: options.tmpDir });
}

function blocksComment(glance: string): boolean {
  return /gh is not installed|gh is not authenticated/.test(glance);
}

export function formatPosted(result: RunResult): string {
  const lines = [result.note];
  if (result.prUrl) lines.push(result.prUrl);
  lines.push(`SVG: ${result.svgPath}`);
  if (result.pngPath) lines.push(`PNG: ${result.pngPath}`);
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

export function writeTimelineFile(
  contents: string | Buffer,
  cwd: string,
  sessionId: string,
  tmpDir: string,
  extension: "svg" | "png",
): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 48) || "session";
  const file = path.join(tmpDir, `prtape-${safe}.${extension}`);
  assertNotInsideProject(file, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o600 });
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

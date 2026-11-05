import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandResult, CommandRunner } from "./gh.js";
import { defaultRunner } from "./gh.js";
import {
  glanceMissingGh,
  glanceNoOrigin,
  glancePushDenied,
  glancePushOther,
  glanceRepoUnreadable,
  glanceUnauth,
  isPermissionFailure,
  orphanRef,
} from "./glance.js";

export const ORPHAN_FILE = "timeline.png";

const ORPHAN_README = `# AgentTape

This orphan ref stores one redacted timeline PNG for a pull-request comment.
It is not on the default branch and it does not merge into main.
`;

export interface HostedPng {
  ok: true;
  url: string;
  sha: string;
  ref: string;
  isPrivate: boolean;
}

export interface HostFailure {
  ok: false;
  glance: string;
}

export type HostResult = HostedPng | HostFailure;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], cwd: string, input?: string) => GitResult;

export function defaultGit(args: string[], cwd: string, input?: string): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export interface HostInput {
  cwd: string;
  png: Buffer;
  runner?: CommandRunner;
  git?: GitRunner;
  tmpRoot?: string;
}

/**
 * Build a parentless commit containing only the PNG and a tiny README, then
 * push it to `refs/agenttape/<head-sha>`. The user's index, HEAD, branch, and
 * working tree are not modified. The comment URL is
 * `https://github.com/{owner}/{repo}/raw/{commit}/timeline.png`.
 */
export async function hostTimelinePng(input: HostInput): Promise<HostResult> {
  const runner = input.runner ?? defaultRunner;
  const git = input.git ?? defaultGit;
  const auth = await runner("gh", ["auth", "status"], { cwd: input.cwd });
  const authGlance = glanceForAuth(auth);
  if (authGlance) return { ok: false, glance: authGlance };

  const repo = await runner("gh", ["repo", "view", "--json", "nameWithOwner,isPrivate,url"], { cwd: input.cwd });
  if (repo.code !== 0) {
    const text = `${repo.stderr}\n${repo.stdout}`;
    if (isPermissionFailure(text) || /auth|not logged/i.test(text)) return { ok: false, glance: glanceUnauth() };
    return { ok: false, glance: glanceRepoUnreadable(repo.stderr || repo.stdout) };
  }

  let parsed: { nameWithOwner?: unknown; isPrivate?: unknown };
  try {
    parsed = JSON.parse(repo.stdout) as { nameWithOwner?: unknown; isPrivate?: unknown };
  } catch {
    return { ok: false, glance: glanceRepoUnreadable("gh repo view did not return JSON.") };
  }
  if (typeof parsed.nameWithOwner !== "string" || !parsed.nameWithOwner.includes("/")) {
    return { ok: false, glance: glanceRepoUnreadable("gh repo view did not return nameWithOwner.") };
  }

  const remote = git(["remote", "get-url", "origin"], input.cwd);
  const remoteUrl = remote.stdout.trim();
  if (remote.code !== 0 || !remoteUrl) return { ok: false, glance: glanceNoOrigin() };

  const head = git(["rev-parse", "HEAD"], input.cwd).stdout.trim();
  const pushed = pushOrphanPng({
    remote: remoteUrl,
    png: input.png,
    anchor: /^[0-9a-f]{7,64}$/i.test(head) ? head : undefined,
    git,
    tmpRoot: input.tmpRoot,
    useGhCredential: /^https:\/\/([^/]+\.)?github\.com\//i.test(remoteUrl),
  });
  if (!pushed.ok) return pushed;

  return {
    ok: true,
    sha: pushed.sha,
    ref: pushed.ref,
    isPrivate: parsed.isPrivate === true,
    url: rawPngUrl(parsed.nameWithOwner, pushed.sha),
  };
}

export function rawPngUrl(nameWithOwner: string, sha: string): string {
  return `https://github.com/${nameWithOwner}/raw/${sha}/${ORPHAN_FILE}`;
}

export function pushOrphanPng(input: {
  remote: string;
  png: Buffer;
  anchor?: string;
  git?: GitRunner;
  tmpRoot?: string;
  useGhCredential?: boolean;
}): (HostedPng) | HostFailure {
  const git = input.git ?? defaultGit;
  const tmp = fs.mkdtempSync(path.join(input.tmpRoot ?? os.tmpdir(), "agenttape-orphan-"));
  const identity = gitIdentity(git);

  const init = git(["init", "-q"], tmp);
  if (init.code !== 0) return { ok: false, glance: glancePushOther(init.stderr || init.stdout) };
  git(["config", "user.name", identity.name], tmp);
  git(["config", "user.email", identity.email], tmp);

  const pngPath = path.join(tmp, ORPHAN_FILE);
  const readmePath = path.join(tmp, "README.md");
  fs.writeFileSync(pngPath, input.png, { mode: 0o600 });
  fs.writeFileSync(readmePath, ORPHAN_README, { mode: 0o600 });

  const pngBlob = git(["hash-object", "-w", pngPath], tmp).stdout.trim();
  const readmeBlob = git(["hash-object", "-w", readmePath], tmp).stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(pngBlob) || !/^[0-9a-f]{40}$/i.test(readmeBlob)) {
    return { ok: false, glance: glancePushOther("git hash-object did not return a blob id.") };
  }

  const anchor = input.anchor && /^[0-9a-f]{7,64}$/i.test(input.anchor) ? input.anchor : pngBlob;
  let ref: string;
  try {
    ref = orphanRef(anchor);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, glance: glancePushOther(message) };
  }

  const treeSpec = [`100644 blob ${readmeBlob}\tREADME.md`, `100644 blob ${pngBlob}\t${ORPHAN_FILE}`, ""].join("\n");
  const tree = git(["mktree"], tmp, treeSpec);
  const treeSha = tree.stdout.trim();
  if (tree.code !== 0 || !/^[0-9a-f]{40}$/i.test(treeSha)) {
    return { ok: false, glance: glancePushOther(tree.stderr || tree.stdout || "git mktree failed.") };
  }

  const commit = git(["commit-tree", treeSha, "-m", "AgentTape timeline"], tmp);
  const commitSha = commit.stdout.trim();
  if (commit.code !== 0 || !/^[0-9a-f]{40}$/i.test(commitSha)) {
    return { ok: false, glance: glancePushOther(commit.stderr || commit.stdout || "git commit-tree failed.") };
  }

  const added = git(["remote", "add", "origin", input.remote], tmp);
  if (added.code !== 0) return { ok: false, glance: glancePushOther(added.stderr || added.stdout) };

  const prefix = input.useGhCredential
    ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]
    : [];
  // `+` forces only this refspec. The destination is refs/agenttape/*, never a branch.
  const push = git([...prefix, "push", "origin", `+${commitSha}:${ref}`], tmp);
  if (push.code !== 0) {
    const text = `${push.stderr}\n${push.stdout}`;
    return { ok: false, glance: isPermissionFailure(text) ? glancePushDenied() : glancePushOther(text) };
  }

  return {
    ok: true,
    sha: commitSha,
    ref,
    url: "",
    isPrivate: false,
  };
}

function glanceForAuth(result: CommandResult): string | null {
  if (result.code === 0) return null;
  const text = `${result.stderr}\n${result.stdout}`;
  if (result.code === 127 || /not found|ENOENT/i.test(text)) return glanceMissingGh();
  return glanceUnauth();
}

function gitIdentity(git: GitRunner): { name: string; email: string } {
  const name = git(["config", "--global", "user.name"], os.tmpdir()).stdout.trim();
  const email = git(["config", "--global", "user.email"], os.tmpdir()).stdout.trim();
  return {
    name: name || "AgentTape",
    email: email || "agenttape@localhost",
  };
}

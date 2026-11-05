import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandResult, CommandRunner } from "./gh.js";
import { defaultRunner } from "./gh.js";
import {
  ORPHAN_BRANCH,
  glanceMissingGh,
  glanceNoOrigin,
  glancePushDenied,
  glancePushOther,
  glanceRepoUnreadable,
  glanceUnauth,
  isMissingRef,
  isPermissionFailure,
} from "./glance.js";

export const ORPHAN_FILE = "timeline.png";

export interface HostedPng {
  ok: true;
  url: string;
  sha: string;
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

export type GitRunner = (args: string[], cwd: string) => GitResult;

export function defaultGit(args: string[], cwd: string): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
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
 * Push `timeline.png` to the orphan branch `agenttape-media` and return a
 * `github.com/.../raw/<sha>/timeline.png` URL. The project working tree is
 * not modified. A failure is a glance string, never a thrown surprise.
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

  const pushed = pushOrphanPng({
    remote: remoteUrl,
    png: input.png,
    git,
    tmpRoot: input.tmpRoot,
    useGhCredential: /^https:\/\/([^/]+\.)?github\.com\//i.test(remoteUrl),
  });
  if (!pushed.ok) return pushed;

  return {
    ok: true,
    sha: pushed.sha,
    isPrivate: parsed.isPrivate === true,
    url: `https://github.com/${parsed.nameWithOwner}/raw/${pushed.sha}/${ORPHAN_FILE}`,
  };
}

export function pushOrphanPng(input: {
  remote: string;
  png: Buffer;
  git?: GitRunner;
  tmpRoot?: string;
  useGhCredential?: boolean;
}): HostResult & { ok: true; sha: string } | HostFailure {
  const git = input.git ?? defaultGit;
  const tmp = fs.mkdtempSync(path.join(input.tmpRoot ?? os.tmpdir(), "agenttape-orphan-"));
  const identity = gitIdentity(git, tmp);

  const init = git(["init", "-b", ORPHAN_BRANCH], tmp);
  if (init.code !== 0) return { ok: false, glance: glancePushOther(init.stderr || init.stdout) };
  git(["config", "user.name", identity.name], tmp);
  git(["config", "user.email", identity.email], tmp);

  const added = git(["remote", "add", "origin", input.remote], tmp);
  if (added.code !== 0) return { ok: false, glance: glancePushOther(added.stderr || added.stdout) };

  const fetch = git(["fetch", "origin", ORPHAN_BRANCH], tmp);
  if (fetch.code !== 0) {
    const text = `${fetch.stderr}\n${fetch.stdout}`;
    if (!isMissingRef(text)) {
      return { ok: false, glance: isPermissionFailure(text) ? glancePushDenied() : glancePushOther(text) };
    }
  } else {
    const checkout = git(["checkout", "-B", ORPHAN_BRANCH, "FETCH_HEAD"], tmp);
    if (checkout.code !== 0) return { ok: false, glance: glancePushOther(checkout.stderr || checkout.stdout) };
  }

  fs.writeFileSync(path.join(tmp, ORPHAN_FILE), input.png, { mode: 0o600 });
  const add = git(["add", ORPHAN_FILE], tmp);
  if (add.code !== 0) return { ok: false, glance: glancePushOther(add.stderr || add.stdout) };
  const commit = git(["commit", "-m", "Add AgentTape timeline PNG"], tmp);
  if (commit.code !== 0) {
    const text = `${commit.stderr}\n${commit.stdout}`;
    if (/nothing to commit/i.test(text)) {
      const existing = git(["rev-parse", "HEAD"], tmp).stdout.trim();
      if (existing) return { ok: true, sha: existing, url: "", isPrivate: false };
    }
    return { ok: false, glance: glancePushOther(text) };
  }
  const shaResult = git(["rev-parse", "HEAD"], tmp);
  const sha = shaResult.stdout.trim();
  if (shaResult.code !== 0 || !sha) return { ok: false, glance: glancePushOther(shaResult.stderr || "missing commit sha") };

  const pushArgs = input.useGhCredential
    ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "push", "origin", `HEAD:${ORPHAN_BRANCH}`]
    : ["push", "origin", `HEAD:${ORPHAN_BRANCH}`];
  const push = git(pushArgs, tmp);
  if (push.code !== 0) {
    const text = `${push.stderr}\n${push.stdout}`;
    return { ok: false, glance: isPermissionFailure(text) ? glancePushDenied() : glancePushOther(text) };
  }
  return { ok: true, sha, url: "", isPrivate: false };
}

function glanceForAuth(result: CommandResult): string | null {
  if (result.code === 0) return null;
  const text = `${result.stderr}\n${result.stdout}`;
  if (result.code === 127 || /not found|ENOENT/i.test(text)) return glanceMissingGh();
  return glanceUnauth();
}

function gitIdentity(git: GitRunner, cwd: string): { name: string; email: string } {
  const name = git(["config", "--global", "user.name"], cwd).stdout.trim();
  const email = git(["config", "--global", "user.email"], cwd).stdout.trim();
  return {
    name: name || "AgentTape",
    email: email || "agenttape@localhost",
  };
}

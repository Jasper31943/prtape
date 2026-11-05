import { spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  (command: string, args: string[], options: { cwd: string; input?: string }): Promise<CommandResult>;
}

export interface PrRef {
  number: number;
  url: string;
  commentId: number;
  /** True when an existing AgentTape comment was edited instead of created. */
  updated: boolean;
}

export class GhError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhError";
  }
}

/**
 * The only network path in AgentTape. `gh` talks to GitHub when the user
 * runs `agenttape pr` without `--dry-run`. There is no telemetry.
 */
export function defaultRunner(
  command: string,
  args: string[],
  options: { cwd: string; input?: string },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        resolve({ code: 127, stdout: "", stderr: `${command} not found` });
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export function explainGhFailure(result: CommandResult): string {
  const text = `${result.stderr}\n${result.stdout}`;
  if (result.code === 127 || /not found|ENOENT/i.test(text)) {
    return "gh is not installed.";
  }
  if (
    /not logged into|gh auth login|GH_TOKEN|GITHUB_TOKEN|HTTP 401|HTTP 403|authentication required|set up authentication/i.test(
      text,
    )
  ) {
    return "gh is not authenticated.";
  }
  if (/no pull requests? found|no prs? found/i.test(text)) {
    return "No pull request for this branch.";
  }
  const detail = result.stderr.trim().split("\n").find((line) => line.trim()) ?? "gh failed.";
  return detail;
}

/** PNG comments and the mermaid fallback both match. Other review chatter does not. */
export function isAgentTapeComment(body: string): boolean {
  return (
    body.includes("![AgentTape timeline](") ||
    body.includes("### AgentTape") ||
    body.includes("Redacted locally by AgentTape")
  );
}

interface IssueComment {
  id?: unknown;
  body?: unknown;
  created_at?: unknown;
  user?: { login?: unknown };
}

/**
 * Create or update one AgentTape comment on the pull request.
 * A second run PATCHes the latest matching comment from the current `gh` user
 * instead of calling `gh pr comment` again.
 */
export async function postComment(
  cwd: string,
  body: string,
  runner: CommandRunner = defaultRunner,
  prNumber?: number,
): Promise<PrRef> {
  const selector = prNumber !== undefined ? [String(prNumber)] : [];
  const view = await runner("gh", ["pr", "view", ...selector, "--json", "number,url,title"], { cwd });
  if (view.code !== 0) throw new GhError(explainGhFailure(view));

  let parsed: { number?: unknown; url?: unknown };
  try {
    parsed = JSON.parse(view.stdout) as { number?: unknown; url?: unknown };
  } catch {
    throw new GhError("gh pr view did not return JSON.");
  }
  if (typeof parsed.number !== "number") {
    throw new GhError("No pull request for this branch.");
  }
  const url = typeof parsed.url === "string" ? parsed.url : "";
  const repo = ownerRepo(url) ?? (await repoSlug(cwd, runner));
  if (!repo) throw new GhError("Could not resolve owner/repo for the pull request comment.");

  const login = await currentLogin(cwd, runner);
  const existing = login ? await latestAgentTapeComment(cwd, runner, repo, parsed.number, login) : undefined;
  const payload = JSON.stringify({ body });
  if (existing) {
    const patched = await runner(
      "gh",
      ["api", "--method", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "--input", "-"],
      { cwd, input: payload },
    );
    if (patched.code !== 0) throw new GhError(explainGhFailure(patched));
    return { number: parsed.number, url, commentId: existing.id, updated: true };
  }

  const created = await runner(
    "gh",
    ["api", "--method", "POST", `repos/${repo}/issues/${parsed.number}/comments`, "--input", "-"],
    { cwd, input: payload },
  );
  if (created.code !== 0) throw new GhError(explainGhFailure(created));
  let commentId = 0;
  try {
    const createdBody = JSON.parse(created.stdout) as { id?: unknown };
    if (typeof createdBody.id === "number") commentId = createdBody.id;
  } catch {
    commentId = 0;
  }
  return { number: parsed.number, url, commentId, updated: false };
}

function ownerRepo(url: string): string | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/pull\/\d+/.exec(url);
  if (!match?.[1] || !match[2]) return undefined;
  return `${match[1]}/${match[2]}`;
}

async function repoSlug(cwd: string, runner: CommandRunner): Promise<string | undefined> {
  const view = await runner("gh", ["repo", "view", "--json", "nameWithOwner"], { cwd });
  if (view.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(view.stdout) as { nameWithOwner?: unknown };
    return typeof parsed.nameWithOwner === "string" ? parsed.nameWithOwner : undefined;
  } catch {
    return undefined;
  }
}

async function currentLogin(cwd: string, runner: CommandRunner): Promise<string | undefined> {
  const user = await runner("gh", ["api", "user"], { cwd });
  if (user.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(user.stdout) as { login?: unknown };
    return typeof parsed.login === "string" ? parsed.login : undefined;
  } catch {
    return undefined;
  }
}

async function latestAgentTapeComment(
  cwd: string,
  runner: CommandRunner,
  repo: string,
  prNumber: number,
  login: string,
): Promise<{ id: number } | undefined> {
  const listed = await runner("gh", ["api", "--paginate", `repos/${repo}/issues/${prNumber}/comments`], { cwd });
  if (listed.code !== 0) throw new GhError(explainGhFailure(listed));
  let comments: IssueComment[] = [];
  try {
    const parsed = JSON.parse(listed.stdout) as unknown;
    if (Array.isArray(parsed)) comments = parsed as IssueComment[];
  } catch {
    throw new GhError("gh api did not return pull request comments as JSON.");
  }
  const mine = comments.filter((comment) => {
    return (
      comment.user?.login === login &&
      typeof comment.body === "string" &&
      isAgentTapeComment(comment.body) &&
      typeof comment.id === "number"
    );
  });
  mine.sort((a, b) => {
    const byTime = String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));
    if (byTime !== 0) return byTime;
    return Number(b.id) - Number(a.id);
  });
  const latest = mine[0];
  return typeof latest?.id === "number" ? { id: latest.id } : undefined;
}

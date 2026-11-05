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

/** Look up the PR for `cwd` (or `prNumber`) and comment with `body` on stdin (not argv). */
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

  const comment = await runner("gh", ["pr", "comment", String(parsed.number), "--body-file", "-"], {
    cwd,
    input: body,
  });
  if (comment.code !== 0) throw new GhError(explainGhFailure(comment));

  return {
    number: parsed.number,
    url: typeof parsed.url === "string" ? parsed.url : "",
  };
}

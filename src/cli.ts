#!/usr/bin/env node
import path from "node:path";
import { runPr, toPublicJson, formatPosted } from "./run.js";
import { NoSessionError } from "./discover.js";
import type { SourceChoice } from "./discover.js";
import { envValue } from "./env.js";
import { VERSION } from "./version.js";

interface Args {
  help: boolean;
  version: boolean;
  command?: string;
  cwd?: string;
  session?: string;
  source: SourceChoice;
  claudeHome?: string;
  dryRun: boolean;
  json: boolean;
  redactEmails: boolean;
  prNumber?: number;
  demo: boolean;
}

const HELP = `PRtape puts one image on the pull request.
See what your AI agent actually did. What the agent did, on the PR.

Usage:
  prtape pr [options]

Options:
  --cwd <dir>              Project directory (default: current directory)
  --session <file>         Claude Code JSONL to read
  --pr <number>            Comment on this pull request (default: PR for the current branch)
  --source auto|claude     Claude Code only for now (default: auto)
  --claude-home <dir>      Claude config directory (default: ~/.claude or $CLAUDE_CONFIG_DIR)
  --dry-run                Print the comment and do not call gh
  --json                   Print the redacted summary as JSON on stdout
  --redact-emails          Also redact email addresses
  --demo                   Tag the timeline as a Demo project
  --label demo             Same as --demo
  -h, --help               Show this help
  -V, --version            Show the version

Examples:
  prtape pr
  prtape pr --dry-run
  prtape pr --json --dry-run
  prtape pr --session fixtures/claude-session.jsonl --dry-run

A real run pushes timeline.png to the orphan ref refs/prtape/<head> and
the comment leads with github.com/.../raw/<sha>/timeline.png. That ref is not
your branch. If gh is missing, not authenticated, or the push is denied,
PRtape prints what failed and how to fix it, then uses the text timeline.
--dry-run writes the PNG locally and does not push or comment.
Claude Code only for now.
`;

async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n\n${HELP}`);
    return 1;
  }

  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.help || !args.command) {
    process.stdout.write(HELP);
    return args.help || !args.command ? 0 : 1;
  }
  if (args.command !== "pr") {
    process.stderr.write(`Unknown command ${args.command}.\n\n${HELP}`);
    return 1;
  }

  try {
    const result = await runPr({
      cwd: args.cwd ?? process.cwd(),
      sessionPath: args.session,
      source: args.source,
      claudeHome: args.claudeHome,
      dryRun: args.dryRun,
      redactEmails: args.redactEmails,
      prNumber: args.prNumber,
      demo: args.demo,
    });
    writeResult(result, args.json);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (envValue("DEBUG") && error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    return error instanceof NoSessionError ? 1 : 1;
  }
}

function writeResult(
  result: Awaited<ReturnType<typeof runPr>>,
  json: boolean,
): void {
  const diagnostics = [
    result.sessionNote,
    result.posted ? undefined : result.note,
    `SVG: ${result.svgPath}`,
    result.pngPath ? `PNG: ${result.pngPath}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  if (json) {
    if (diagnostics) process.stderr.write(`${diagnostics}\n`);
    if (result.posted) {
      process.stderr.write(`${result.note}\n`);
      if (result.prUrl) process.stderr.write(`${result.prUrl}\n`);
    }
    process.stdout.write(
      `${JSON.stringify(toPublicJson(result.summary, { imageHosted: result.imageHosted, imageUrl: result.imageUrl }), null, 2)}\n`,
    );
    return;
  }

  if (result.posted) {
    process.stdout.write(formatPosted(result));
    if (result.sessionNote) process.stderr.write(`${result.sessionNote}\n`);
    return;
  }

  if (diagnostics) process.stderr.write(`${diagnostics}\n`);
  process.stdout.write(result.comment.endsWith("\n") ? result.comment : `${result.comment}\n`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    help: false,
    version: false,
    source: "auto",
    dryRun: false,
    json: false,
    redactEmails: false,
    demo: false,
  };
  const rest = argv.slice(2);
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) continue;
    const take = (): string => {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`Missing value for ${token}`);
      }
      index += 1;
      return value;
    };
    switch (token) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-V":
      case "--version":
        args.version = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--redact-emails":
        args.redactEmails = true;
        break;
      case "--demo":
        args.demo = true;
        break;
      case "--label":
        if (take() === "demo") args.demo = true;
        break;
      case "--cwd":
        args.cwd = take();
        break;
      case "--session":
        args.session = take();
        break;
      case "--pr": {
        const value = Number(take());
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error("--pr expects a positive pull request number");
        }
        args.prNumber = value;
        break;
      }
      case "--claude-home":
        args.claudeHome = take();
        break;
      case "--source": {
        const value = take();
        if (value !== "auto" && value !== "claude") {
          throw new Error(`Unknown --source ${value}. Use auto or claude.`);
        }
        args.source = value;
        break;
      }
      default:
        if (token.startsWith("-")) throw new Error(`Unknown option ${token}`);
        positional.push(token);
    }
  }
  if (positional.length > 1) {
    throw new Error(`Unexpected argument ${positional.slice(1).join(" ")}`);
  }
  args.command = positional[0];
  if (args.cwd) args.cwd = path.resolve(args.cwd);
  return args;
}

main(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  },
);

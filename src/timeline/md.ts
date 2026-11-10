import type { SessionSummary } from "../types.js";
import type { RedactOptions } from "../redact.js";
import { VERSION } from "../version.js";
import { presentSummary } from "../display.js";
import { escapeMdCell, oneLine } from "../text.js";
import {
  asciiFlow,
  decisionLine,
  formatWhen,
  publicSteps,
  sourceLabel,
  stepText,
  testsPhrase,
} from "./format.js";
import { rollupTests } from "../summary.js";

export interface CommentImage {
  url: string;
  isPrivate: boolean;
  /** Dry-run image name. The absolute path stays on stderr. */
  dryRun?: boolean;
}

/**
 * Pull-request comment body.
 *
 * The happy path leads with the hosted PNG (`github.com/.../raw/<sha>/timeline.png`),
 * then the one-line decision and a short table. Mermaid and ASCII are the
 * fallback when the orphan ref was not pushed.
 */
export function renderComment(
  input: SessionSummary,
  options: RedactOptions = {},
  image?: CommentImage,
  demo = false,
): string {
  const summary = presentSummary(input, options).summary;
  const decision = decisionLine(summary, 200);
  const when = formatWhen(summary.startedAt);
  const sourceBits = [
    sourceLabel(summary.source),
    summary.branch ? `\`${summary.branch.replace(/`/g, "")}\`` : undefined,
    when,
  ].filter((bit): bit is string => Boolean(bit));

  const fileNames = summary.files.slice(0, 8).map((file) => `\`${file.path.replace(/`/g, "")}\``);
  const extraFiles = summary.files.length - fileNames.length;
  const files =
    fileNames.length === 0
      ? "none"
      : `${fileNames.join(" · ")}${extraFiles > 0 ? ` · +${extraFiles}` : ""}`;

  const table = [
    "| | |",
    "| --- | --- |",
    `| Source | ${escapeMdCell(sourceBits.join(" · "))} |`,
    `| Files touched | ${escapeMdCell(files)} |`,
    `| Tests | ${escapeMdCell(testsCell(summary))} |`,
  ];
  const footer = `_Redacted locally by AgentTape ${VERSION}. The raw session was not posted._`;
  const lines = image
    ? [
        `![AgentTape timeline](${image.url})`,
        "",
        `**${escapeMdCell(decision)}**`,
        "",
        ...(demo ? ["Demo project", ""] : []),
        ...table,
        "",
        image.dryRun ? dryRunNote() : visibilityNote(image.isPrivate),
        "",
        footer,
        "",
      ]
    : [
        "### AgentTape",
        "",
        `**${escapeMdCell(decision)}**`,
        "",
        ...(demo ? ["Demo project", ""] : []),
        "```text",
        asciiFlow(summary),
        "```",
        "",
        ...table,
        "",
        "```mermaid",
        mermaid(summary),
        "```",
        "",
        "<details>",
        "<summary>Steps</summary>",
        "",
        ...publicSteps(summary.steps).map((step, index) => `${index + 1}. ${stepText(step)}`),
        "",
        "</details>",
        "",
        `_Redacted locally by AgentTape ${VERSION}. The raw session was not posted. This is the text timeline (ASCII + mermaid). GitHub strips inline SVG._`,
        "",
      ];
  return lines.join("\n");
}

function dryRunNote(): string {
  return [
    "_Dry run. Nothing was uploaded and no comment was posted. The local PNG path is printed on stderr, not in this comment._",
    "_A real `agenttape pr` pushes the PNG to the orphan ref `refs/agenttape/<head>` and the comment leads with `https://github.com/{owner}/{repo}/raw/{sha}/timeline.png`._",
    "_On a public repo, logged-out viewers see that image. On a private repo they may not; collaborators who can open the repo usually see it._",
  ].join(" ");
}

function visibilityNote(isPrivate: boolean): string {
  const which = isPrivate ? "This repo is private." : "This repo is public.";
  return [
    which,
    "On a public repo, anonymous viewers see the PNG at `github.com/.../raw/<sha>/...`.",
    "On a private repo, logged-out users, email notifications, and some mobile clients may show a broken image.",
    "Collaborators who can open the repo usually see it.",
  ].join(" ");
}

function testsCell(summary: SessionSummary): string {
  const phrase = testsPhrase(summary);
  if (!summary.testsRun) return phrase;
  const parts = phrase.split(" · ");
  if (parts.length < 3) return phrase;
  const command = parts.slice(2).join(" · ").replace(/`/g, "");
  return `${parts[0]} · ${parts[1]} · \`${command}\``;
}

function mermaid(summary: SessionSummary): string {
  const count = summary.files.length;
  const files = count === 0 ? "No edits" : `${count} file${count === 1 ? "" : "s"}`;
  const outcome = rollupTests(summary.tests);
  const tests = !summary.testsRun
    ? "Tests not run"
    : outcome === "pass"
      ? "Tests pass"
      : outcome === "fail"
        ? "Tests fail"
        : "Tests ran";
  return [
    "flowchart LR",
    "  stepAsk[Ask] --> stepFiles[" + files + "]",
    "  stepFiles --> stepTests[" + tests + "]",
    "  stepTests --> stepShip[Ship]",
  ].join("\n");
}

export function terminalSummary(summary: SessionSummary): string {
  return `${oneLine(summary.decision)}\n${asciiFlow(summary)}`;
}

import type { SessionSummary } from "../types.js";
import type { RedactOptions } from "../redact.js";
import { redactSession } from "../redact.js";
import { VERSION } from "../version.js";
import { escapeMdCell, oneLine } from "../text.js";
import {
  asciiFlow,
  decisionLine,
  formatWhen,
  sourceLabel,
  stepText,
  testsPhrase,
} from "./format.js";
import { rollupTests } from "../summary.js";

export interface CommentImage {
  url: string;
  isPrivate: boolean;
}

/**
 * Pull-request comment body.
 *
 * GitHub strips inline SVG. When a PNG was pushed to the orphan branch, the
 * comment leads with that `github.com/.../raw/<sha>/...` image and still keeps
 * the ASCII and mermaid timeline, because a private repo does not show the
 * image to everyone. Without a hosted PNG, the comment is the text timeline only.
 */
export function renderComment(
  input: SessionSummary,
  options: RedactOptions = {},
  image?: CommentImage,
): string {
  const summary = redactSession(input, options);
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

  const lines = [
    "### AgentTape",
    "",
    `**${escapeMdCell(decision)}**`,
    "",
    ...(image ? imageBlock(image) : []),
    "```text",
    asciiFlow(summary),
    "```",
    "",
    "| | |",
    "| --- | --- |",
    `| Source | ${escapeMdCell(sourceBits.join(" · "))} |`,
    `| Files touched | ${escapeMdCell(files)} |`,
    `| Tests | ${escapeMdCell(testsCell(summary))} |`,
    "",
    "```mermaid",
    mermaid(summary),
    "```",
    "",
    "<details>",
    "<summary>Steps</summary>",
    "",
    ...summary.steps.map((step, index) => `${index + 1}. ${stepText(step)}`),
    "",
    "</details>",
    "",
    image
      ? `_Redacted locally by AgentTape ${VERSION}. The raw session was not posted._`
      : `_Redacted locally by AgentTape ${VERSION}. The raw session was not posted. This is the text timeline (ASCII + mermaid). GitHub strips inline SVG._`,
    "",
  ];
  return lines.join("\n");
}

function imageBlock(image: CommentImage): string[] {
  return [`![AgentTape timeline](${image.url})`, "", visibilityNote(image.isPrivate), ""];
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
  const phrase = testsPhrase(summary, "table");
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

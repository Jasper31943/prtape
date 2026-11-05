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

/**
 * Pull-request comment body.
 *
 * GitHub's markdown sanitizer removes inline `<svg>` and data-URI images,
 * so the comment is a one-line decision, an ASCII flow, a short table, and
 * a mermaid diagram. The SVG from `renderSvg` is written to a temp file.
 */
export function renderComment(input: SessionSummary, options: RedactOptions = {}): string {
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
    `_Redacted locally by AgentTape ${VERSION}. The raw session was not posted. GitHub comments strip inline SVG; the SVG timeline is on the machine that ran the CLI._`,
    "",
  ];
  return lines.join("\n");
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

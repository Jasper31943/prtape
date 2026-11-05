import type { SessionSummary } from "../types.js";
import type { RedactOptions } from "../redact.js";
import { redactSession } from "../redact.js";
import { escapeXml } from "../text.js";
import {
  askLine,
  decisionLine,
  filesDetail,
  footerLine,
  formatWhen,
  sourceLabel,
  testsPhrase,
} from "./format.js";

const WIDTH = 760;
const HEIGHT = 360;
const FONT = "ui-sans-serif, system-ui, sans-serif";

const INK = "#1c1714";
const MUTED = "#6f675e";
const PAPER = "#f3efe6";
const CARD = "#fbf8f2";
const HAIRLINE = "#e3dcd0";
const RAIL = "#d9d0c3";
const ASK = "#3d5c4a";
const EDIT = "#8f4320";
const PASS = "#2c6a4a";
const FAIL = "#8d2f2c";
const AMBER = "#8a5a12";

interface Row {
  label: string;
  detail: string;
  color: string;
}

/**
 * Compact SVG timeline. Four beats: ask, files, tests, decision.
 * GitHub strips inline SVG in comments, so this file is written locally
 * and the pull-request comment uses the markdown timeline instead.
 */
export function renderSvg(input: SessionSummary, options: RedactOptions = {}): string {
  const summary = redactSession(input, options);
  const rows = timelineRows(summary);
  const metaBits = [summary.branch, formatWhen(summary.startedAt)].filter(
    (bit): bit is string => Boolean(bit),
  );
  const meta = metaBits.join("   ·   ") || "redacted";
  const source = sourceLabel(summary.source);
  const decision = decisionLine(summary, 90);
  const title = `AgentTape timeline · ${source}`;

  const rowY = [128, 176, 224, 272];
  const parts: string[] = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img">`,
  );
  parts.push(`  <title>${escapeXml(title)}</title>`);
  parts.push(`  <desc>${escapeXml(decision)}</desc>`);
  parts.push(`  <rect width="${WIDTH}" height="${HEIGHT}" rx="18" fill="${PAPER}"/>`);
  parts.push(`  <rect x="16" y="16" width="728" height="328" rx="12" fill="${CARD}" stroke="${HAIRLINE}"/>`);
  parts.push(text(40, 52, "AGENTTAPE", { size: 12, fill: MUTED, spacing: "1.8" }));
  parts.push(text(720, 52, source, { size: 13, fill: INK, anchor: "end" }));
  parts.push(text(40, 76, meta, { size: 12, fill: MUTED }));
  parts.push(`  <line x1="40" y1="94" x2="720" y2="94" stroke="${HAIRLINE}"/>`);
  parts.push(
    `  <line x1="48" y1="${rowY[0]}" x2="48" y2="${rowY[rowY.length - 1]}" stroke="${RAIL}" stroke-width="2"/>`,
  );
  rows.forEach((row, index) => {
    const y = rowY[index] ?? 128;
    parts.push(`  <circle cx="48" cy="${y}" r="6.5" fill="${CARD}"/>`);
    parts.push(`  <circle cx="48" cy="${y}" r="4.5" fill="${row.color}"/>`);
    parts.push(text(72, y + 4, row.label, { size: 11, fill: MUTED, spacing: "1.2" }));
    parts.push(text(140, y + 4, row.detail, { size: 15, fill: INK }));
  });
  parts.push(text(72, 318, footerLine(summary), { size: 12, fill: MUTED }));
  parts.push(`</svg>`);
  parts.push("");
  return parts.join("\n");
}

function timelineRows(summary: SessionSummary): Row[] {
  const outcome = testsPhrase(summary, "svg");
  let testColor = MUTED;
  if (summary.testsRun) {
    if (outcome.startsWith("yes · pass")) testColor = PASS;
    else if (outcome.startsWith("yes · fail")) testColor = FAIL;
    else testColor = AMBER;
  }
  return [
    { label: "ASK", detail: askLine(summary, 72), color: ASK },
    {
      label: "FILES",
      detail: truncateDetail(filesDetail(summary, 3), 72),
      color: summary.files.length > 0 ? EDIT : MUTED,
    },
    { label: "TESTS", detail: truncateDetail(outcome, 78), color: testColor },
    { label: "SHIP", detail: decisionLine(summary, 78), color: INK },
  ];
}

function truncateDetail(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

function text(
  x: number,
  y: number,
  value: string,
  style: { size: number; fill: string; spacing?: string; anchor?: "end" | "start" },
): string {
  const spacing = style.spacing ? ` letter-spacing="${style.spacing}"` : "";
  const anchor = style.anchor === "end" ? ` text-anchor="end"` : "";
  return `  <text x="${x}" y="${y}" fill="${style.fill}" font-family="${FONT}" font-size="${style.size}"${spacing}${anchor}>${escapeXml(value)}</text>`;
}

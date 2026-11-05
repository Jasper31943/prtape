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

/** Titles. Fallbacks match the brand palette. */
const SANS = "Inter, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', sans-serif";
/** Paths, commands, and labels. */
const MONO = "JetBrains Mono, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace";

const BG = "#0B0F14";
const SURFACE = "#131A22";
const SURFACE2 = "#1B2430";
const LINE = "#263241";
const INK = "#E6EDF3";
const MUTED = "#7D8A99";
const ACCENT = "#39FF88";
const ACCENT2 = "#22D3EE";
const ADD = "#3DDC84";
const REMOVE = "#FF5C7A";
const WARN = "#FFB454";

interface Row {
  label: string;
  detail: string;
  color: string;
  mono: boolean;
}

/**
 * Compact dark timeline.
 *
 * Brand rules baked in: the reel ring is the only gradient (accent → accent2
 * at 135°), and the REDACTED badge is the only element that glows. Pass uses
 * `add`, fail uses `remove`. Muted text stays at 13px or larger.
 * GitHub strips inline SVG, so the pull-request comment is markdown and this
 * file is written under the system temp directory.
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

  const badgeW = 104;
  const badgeX = 628;
  const sourceW = Math.max(92, source.length * 8 + 22);
  const sourceX = badgeX - 10 - sourceW;

  const rowY = [132, 180, 228, 276];
  const parts: string[] = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img">`,
  );
  parts.push(`  <title>${escapeXml(title)}</title>`);
  parts.push(`  <desc>${escapeXml(decision)}</desc>`);
  parts.push(`  <defs>`);
  parts.push(`    <linearGradient id="reel" x1="0" y1="0" x2="1" y2="1">`);
  parts.push(`      <stop offset="0" stop-color="${ACCENT}"/>`);
  parts.push(`      <stop offset="1" stop-color="${ACCENT2}"/>`);
  parts.push(`    </linearGradient>`);
  parts.push(
    `    <filter id="accent-glow" x="-50%" y="-80%" width="200%" height="260%" color-interpolation-filters="sRGB">`,
  );
  parts.push(`      <feGaussianBlur stdDeviation="2.4" result="blur"/>`);
  parts.push(`      <feMerge>`);
  parts.push(`        <feMergeNode in="blur"/>`);
  parts.push(`        <feMergeNode in="SourceGraphic"/>`);
  parts.push(`      </feMerge>`);
  parts.push(`    </filter>`);
  parts.push(`  </defs>`);
  parts.push(`  <rect width="${WIDTH}" height="${HEIGHT}" rx="18" fill="${BG}"/>`);
  parts.push(`  <rect x="16" y="16" width="728" height="328" rx="12" fill="${SURFACE}" stroke="${LINE}"/>`);
  parts.push(reel(40, 48));
  parts.push(text(60, 54, "AgentTape", { size: 18, fill: INK, family: "sans", weight: 800 }));
  parts.push(text(40, 78, meta, { size: 13, fill: MUTED, family: "mono" }));
  parts.push(capsule(sourceX, 36, sourceW, 24, source));
  parts.push(redactedBadge(badgeX, 36, badgeW, 24));
  parts.push(`  <line x1="40" y1="100" x2="720" y2="100" stroke="${LINE}"/>`);
  parts.push(
    `  <line x1="48" y1="${rowY[0]}" x2="48" y2="${rowY[rowY.length - 1]}" stroke="${LINE}" stroke-width="2"/>`,
  );
  rows.forEach((row, index) => {
    const y = rowY[index] ?? 132;
    parts.push(`  <circle cx="48" cy="${y}" r="7" fill="${SURFACE}"/>`);
    parts.push(`  <circle cx="48" cy="${y}" r="4" fill="${row.color}"/>`);
    parts.push(text(72, y + 4, row.label, { size: 13, fill: MUTED, family: "mono", spacing: "1.1" }));
    parts.push(
      text(150, y + 4, row.detail, {
        size: row.mono ? 14 : 15,
        fill: INK,
        family: row.mono ? "mono" : "sans",
      }),
    );
  });
  parts.push(text(72, 322, footerLine(summary), { size: 13, fill: MUTED, family: "mono" }));
  parts.push(`</svg>`);
  parts.push("");
  return parts.join("\n");
}

/** Outer ring is the only gradient in the image. It does not glow. */
function reel(cx: number, cy: number): string {
  return [
    `  <circle cx="${cx}" cy="${cy}" r="12" fill="${SURFACE}" stroke="url(#reel)" stroke-width="2.5"/>`,
    `  <circle cx="${cx}" cy="${cy}" r="3.5" fill="${SURFACE2}"/>`,
  ].join("\n");
}

function capsule(x: number, y: number, width: number, height: number, label: string): string {
  const tx = x + width / 2;
  const ty = y + height / 2 + 4;
  return [
    `  <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" fill="${SURFACE2}" stroke="${LINE}"/>`,
    text(tx, ty, label, { size: 13, fill: INK, family: "mono", anchor: "middle" }),
  ].join("\n");
}

/** The only accent glow. Dark text sits on the green pill. */
function redactedBadge(x: number, y: number, width: number, height: number): string {
  const tx = x + width / 2;
  const ty = y + height / 2 + 4;
  return [
    `  <g filter="url(#accent-glow)">`,
    `    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" fill="${ACCENT}"/>`,
    text(tx, ty, "REDACTED", { size: 12, fill: BG, family: "mono", weight: 700, anchor: "middle" }),
    `  </g>`,
  ].join("\n");
}

function timelineRows(summary: SessionSummary): Row[] {
  const outcome = testsPhrase(summary, "svg");
  let testColor: string = MUTED;
  if (summary.testsRun) {
    if (outcome.startsWith("yes · pass")) testColor = ADD;
    else if (outcome.startsWith("yes · fail")) testColor = REMOVE;
    else testColor = WARN;
  }
  return [
    { label: "ASK", detail: askLine(summary, 72), color: ACCENT2, mono: false },
    {
      label: "FILES",
      detail: truncateDetail(filesDetail(summary, 3), 64),
      color: summary.files.length > 0 ? ACCENT2 : MUTED,
      mono: true,
    },
    { label: "TESTS", detail: truncateDetail(outcome, 68), color: testColor, mono: true },
    { label: "SHIP", detail: decisionLine(summary, 70), color: INK, mono: false },
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
  style: {
    size: number;
    fill: string;
    family: "sans" | "mono";
    weight?: number;
    spacing?: string;
    anchor?: "start" | "middle" | "end";
  },
): string {
  const family = style.family === "mono" ? MONO : SANS;
  const weight = style.weight ? ` font-weight="${style.weight}"` : "";
  const spacing = style.spacing ? ` letter-spacing="${style.spacing}"` : "";
  const anchor = style.anchor && style.anchor !== "start" ? ` text-anchor="${style.anchor}"` : "";
  return `  <text x="${x}" y="${y}" fill="${style.fill}" font-family="${family}" font-size="${style.size}"${weight}${spacing}${anchor}>${escapeXml(value)}</text>`;
}

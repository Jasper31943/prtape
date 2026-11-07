import type { SessionSummary } from "../types.js";
import type { RedactOptions } from "../redact.js";
import { presentSummary } from "../display.js";
import { escapeXml } from "../text.js";
import { rollupTests, sawFailureThenPass } from "../summary.js";
import { sourceLabel, testsPhrase } from "./format.js";

const WIDTH = 960;
const HEIGHT = 480;

const MONO = "JetBrains Mono, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace";
const SANS = "Inter, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', sans-serif";

const BG = "#0B0F14";
const CARD = "#101820";
const ROW = "#17212C";
const TRACK = "#1B2430";
const INK = "#E6EDF3";
const MUTED = "#7D8A99";
const ACCENT = "#39FF88";
const ACCENT2 = "#22D3EE";
const ADD = "#3DDC84";
const REMOVE = "#FF5C7A";
const READ = "#33445A";
const CHIP = "#0F2A1D";

const BEATS: { label: string; color: string }[] = [
  { label: "read", color: READ },
  { label: "edit", color: ACCENT2 },
  { label: "fail", color: REMOVE },
  { label: "fix", color: ACCENT2 },
  { label: "pass", color: ADD },
  { label: "commit", color: ACCENT },
];

/**
 * 960×480 PR timeline. Six-segment horizontal track, then FILES / TESTS /
 * KEY DECISION. Secrets are omitted, not masked in the body or the footer.
 */
export function renderSvg(input: SessionSummary, options: RedactOptions = {}): string {
  const { summary, maskedCount } = presentSummary(input, options);
  const active = activeBeats(summary);
  const source = sourceLabel(summary.source);
  const parts: string[] = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img">`,
  );
  parts.push(`  <title>${escapeXml(`AgentTape timeline · ${source}`)}</title>`);
  parts.push(`  <desc>${escapeXml(summary.decision)}</desc>`);
  parts.push(`  <defs>`);
  parts.push(`    <linearGradient id="reel" x1="0" y1="0" x2="1" y2="1">`);
  parts.push(`      <stop offset="0" stop-color="${ACCENT}"/>`);
  parts.push(`      <stop offset="1" stop-color="${ACCENT2}"/>`);
  parts.push(`    </linearGradient>`);
  parts.push(`  </defs>`);
  parts.push(`  <rect width="${WIDTH}" height="${HEIGHT}" rx="18" fill="${BG}"/>`);
  parts.push(`  <rect x="16" y="16" width="928" height="448" rx="14" fill="${CARD}" stroke="${ACCENT}" stroke-width="1.5"/>`);
  parts.push(reelMark(28, 26, 48));
  parts.push(wordmark(86, 52));
  parts.push(chips(source, maskedCount));
  parts.push(track(active));
  parts.push(filesRow(summary));
  parts.push(testsRow(summary));
  parts.push(decisionRow(summary.decision));
  parts.push(footer());
  parts.push(`</svg>`);
  parts.push("");
  return parts.join("\n");
}

function activeBeats(summary: SessionSummary): Set<string> {
  const on = new Set<string>(["read", "commit"]);
  if (summary.files.length > 0) on.add("edit");
  const failed = summary.tests.some((test) => test.outcome === "fail");
  const passed = summary.tests.some((test) => test.outcome === "pass");
  if (failed) on.add("fail");
  if (sawFailureThenPass(summary.tests)) on.add("fix");
  if (passed) on.add("pass");
  return on;
}

/**
 * Reel portion of logo-mark.svg. The prompt caret is left out here: at header
 * size it reads as a terminal `>_` glyph. The arc, tape, and hubs stay.
 */
function reelMark(x: number, y: number, size: number): string {
  const scale = (size / 128).toFixed(4);
  return [
    `  <g transform="translate(${x} ${y}) scale(${scale})" aria-label="AgentTape reel">`,
    `    <rect width="128" height="128" rx="28" fill="${BG}"/>`,
    `    <g transform="translate(0 6)">`,
    `      <path d="M112 91 H52 A33 33 0 1 1 52 25 A33 33 0 1 1 52 91" fill="none" stroke="url(#reel)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>`,
    `      <rect x="62" y="68" width="14" height="6" rx="1.5" fill="${ACCENT}"/>`,
    `      <circle cx="82" cy="91" r="5.5" fill="${ACCENT}" stroke="${BG}" stroke-width="3"/>`,
    `      <circle cx="102" cy="91" r="5.5" fill="${REMOVE}" stroke="${BG}" stroke-width="3"/>`,
    `    </g>`,
    `  </g>`,
  ].join("\n");
}

function wordmark(x: number, y: number): string {
  return [
    `  <text x="${x}" y="${y}" font-family="${MONO}" font-size="20" font-weight="800">`,
    `    <tspan fill="${INK}">Agent</tspan><tspan fill="${ACCENT}">Tape</tspan>`,
    `    <tspan fill="${MUTED}" font-size="14" font-weight="400"> · agent replay</tspan>`,
    `  </text>`,
  ].join("\n");
}

function chips(source: string, maskedCount: number): string {
  const masked = maskedCount > 0 ? `redacted ×${maskedCount}` : "";
  const maskedW = masked ? Math.max(108, masked.length * 8 + 22) : 0;
  const sourceW = Math.max(108, source.length * 8.2 + 24);
  const right = 928;
  const maskedX = right - maskedW;
  const sourceX = (masked ? maskedX : right) - 8 - sourceW;
  const chunks = [
    `  <rect x="${sourceX}" y="34" width="${sourceW}" height="28" rx="14" fill="${TRACK}" stroke="#263241"/>`,
    text(sourceX + sourceW / 2, 53, source, { size: 13, fill: INK, family: "mono", anchor: "middle" }),
  ];
  if (masked) {
    chunks.push(`  <rect x="${maskedX}" y="34" width="${maskedW}" height="28" rx="14" fill="${CHIP}" stroke="${ACCENT}"/>`);
    chunks.push(text(maskedX + maskedW / 2, 53, masked, { size: 13, fill: ACCENT, family: "mono", weight: 700, anchor: "middle" }));
  }
  return chunks.join("\n");
}

function track(active: Set<string>): string {
  const beats = BEATS.filter((beat) => active.has(beat.label));
  const x0 = 36;
  const y = 78;
  const width = 888;
  const gap = 6;
  const blockW = (width - gap * (beats.length - 1)) / beats.length;
  const chunks: string[] = [`  <rect x="${x0}" y="${y}" width="${width}" height="22" rx="6" fill="${TRACK}"/>`];
  beats.forEach((beat, index) => {
    const x = x0 + index * (blockW + gap);
    chunks.push(`  <rect x="${x.toFixed(1)}" y="${y}" width="${blockW.toFixed(1)}" height="22" rx="4" fill="${beat.color}"/>`);
    chunks.push(
      text(x + blockW / 2, y + 40, beat.label, {
        size: 13,
        fill: beat.color,
        family: "mono",
        anchor: "middle",
      }),
    );
  });
  return chunks.join("\n");
}

function filesRow(summary: SessionSummary): string {
  const y = 132;
  const names = summary.files.slice(0, 4).map((file) => file.path);
  const extra = summary.files.length - names.length;
  const chunks = [row(y, 86), heading(y, "FILES TOUCHED", String(summary.files.length))];
  let x = 48;
  if (names.length === 0) {
    chunks.push(text(48, y + 58, "No files edited", { size: 16, fill: MUTED, family: "sans" }));
    return chunks.join("\n");
  }
  for (const name of names) {
    const w = name.length * 8.6 + 28;
    chunks.push(`  <rect x="${x}" y="${y + 40}" width="${w.toFixed(1)}" height="28" rx="7" fill="${BG}" stroke="#263241"/>`);
    chunks.push(text(x + 14, y + 59, name, { size: 14, fill: INK, family: "mono" }));
    x += w + 18;
  }
  if (extra > 0) chunks.push(text(x, y + 59, `+${extra}`, { size: 14, fill: MUTED, family: "mono" }));
  return chunks.join("\n");
}

function testsRow(summary: SessionSummary): string {
  const y = 226;
  const phrase = testsPhrase(summary);
  const outcome = rollupTests(summary.tests);
  const color = outcome === "pass" ? ADD : outcome === "fail" ? REMOVE : MUTED;
  const mark = !summary.testsRun ? "–" : outcome === "fail" ? "✕" : "✓";
  return [
    row(y, 78),
    heading(y, "TESTS RAN", ""),
    text(48, y + 56, mark, { size: 18, fill: color, family: "sans", weight: 700 }),
    text(72, y + 56, phrase, { size: 18, fill: color, family: "mono" }),
  ].join("\n");
}

function decisionRow(decision: string): string {
  const y = 312;
  return [
    row(y, 86),
    heading(y, "KEY DECISION", ""),
    text(48, y + 58, clip(decision, 78), { size: 20, fill: INK, family: "sans", weight: 700 }),
  ].join("\n");
}

function footer(): string {
  return text(36, 436, "redacted before posting · raw session never uploaded", { size: 13, fill: MUTED, family: "mono" });
}

function row(y: number, height: number): string {
  return `  <rect x="32" y="${y}" width="896" height="${height}" rx="10" fill="${ROW}"/>`;
}

function heading(y: number, label: string, count: string): string {
  const suffix = count ? ` · ${count}` : "";
  return text(48, y + 24, `${label}${suffix}`, { size: 13, fill: MUTED, family: "mono", weight: 700 });
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

function text(
  x: number,
  y: number,
  value: string,
  style: { size: number; fill: string; family: "sans" | "mono"; weight?: number; anchor?: "start" | "middle" | "end" },
): string {
  const family = style.family === "mono" ? MONO : SANS;
  const weight = style.weight ? ` font-weight="${style.weight}"` : "";
  const anchor = style.anchor && style.anchor !== "start" ? ` text-anchor="${style.anchor}"` : "";
  return `  <text x="${x.toFixed(1)}" y="${y}" fill="${style.fill}" font-family="${family}" font-size="${style.size}"${weight}${anchor}>${escapeXml(value)}</text>`;
}

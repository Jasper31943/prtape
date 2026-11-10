import type { SessionSummary } from "../types.js";
import type { RedactOptions } from "../redact.js";
import { presentSummary } from "../display.js";
import { escapeXml } from "../text.js";
import { rollupTests } from "../summary.js";
import type { TimelineEvent } from "../types.js";
import { solePass, sourceLabel, testsPhrase, testsTransition } from "./format.js";
import { textWidth, wrapText } from "./wrap.js";

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
/** Same brightness as the other phase colors. #33445A sat in the background and looked unused. */
const READ = "#7A8FB0";
const CHIP = "#0F2A1D";

const BEAT_COLOR: Record<string, string> = {
  read: READ,
  edit: ACCENT2,
  fail: REMOVE,
  pass: ADD,
  commit: ACCENT,
};

/**
 * 960×480 PR timeline. Six-segment horizontal track, then FILES / TESTS /
 * KEY DECISION. Secrets are omitted, not masked in the body or the footer.
 */
export function renderSvg(input: SessionSummary, options: RedactOptions = {}, demo = false): string {
  const { summary, maskedCount } = presentSummary(input, options);
  const beats = observedBeats(summary);
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
  parts.push(chips(source, maskedCount, demo));
  parts.push(track(beats));
  parts.push(filesRow(summary));
  parts.push(testsRow(summary));
  parts.push(decisionRow(summary.decision));
  parts.push(footer());
  parts.push(`</svg>`);
  parts.push("");
  return parts.join("\n");
}

/**
 * Headline phases. The step list keeps every event. The track drops setup
 * reads before the first test, verification reads after the last edit, and
 * pathless reads such as a bare `git diff`.
 */
function observedBeats(summary: SessionSummary): { label: string; color: string }[] {
  const beats: { label: string; color: string }[] = [];
  for (const label of phaseLabels(summary.events)) {
    if (beats.at(-1)?.label === label) continue;
    const color = BEAT_COLOR[label];
    if (!color) continue;
    beats.push({ label, color });
  }
  return beats;
}

function phaseLabels(events: TimelineEvent[]): string[] {
  const hasTest = events.some((event) => event.kind === "test" && (event.outcome === "fail" || event.outcome === "pass"));
  let firstTest = -1;
  let lastEdit = -1;
  events.forEach((event, index) => {
    if (firstTest < 0 && event.kind === "test" && (event.outcome === "fail" || event.outcome === "pass")) firstTest = index;
    if (event.kind === "edit") lastEdit = index;
  });
  const labels: string[] = [];
  events.forEach((event, index) => {
    if (event.kind === "read") {
      if (!event.path) return;
      if (hasTest && index < firstTest) return;
      if (lastEdit >= 0 && index > lastEdit) return;
    }
    const label = beatLabel(event);
    if (label) labels.push(label);
  });
  return labels;
}

function beatLabel(event: TimelineEvent): string | undefined {
  switch (event.kind) {
    case "read":
      return "read";
    case "edit":
      return "edit";
    case "test":
      if (event.outcome === "fail") return "fail";
      if (event.outcome === "pass") return "pass";
      return undefined;
    case "commit":
      return "commit";
    default: {
      const never: never = event;
      return never;
    }
  }
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

function chips(source: string, maskedCount: number, demo: boolean): string {
  const masked = maskedCount > 0 ? `redacted ×${maskedCount}` : "";
  const maskedW = masked ? Math.max(108, masked.length * 8 + 22) : 0;
  const sourceW = Math.max(108, source.length * 8.2 + 24);
  const demoLabel = demo ? "Demo project" : "";
  const demoW = demoLabel ? Math.max(108, demoLabel.length * 8.2 + 24) : 0;
  const right = 928;
  const maskedX = right - maskedW;
  const sourceX = (masked ? maskedX : right) - 8 - sourceW;
  const demoX = sourceX - (demoW ? 8 + demoW : 0);
  const chunks = [
    `  <rect x="${sourceX}" y="34" width="${sourceW}" height="28" rx="14" fill="${TRACK}" stroke="#263241"/>`,
    text(sourceX + sourceW / 2, 53, source, { size: 13, fill: INK, family: "mono", anchor: "middle" }),
  ];
  if (demoLabel) {
    chunks.push(
      `  <rect x="${demoX}" y="34" width="${demoW.toFixed(1)}" height="28" rx="14" fill="none" stroke="${MUTED}"/>`,
    );
    chunks.push(text(demoX + demoW / 2, 53, demoLabel, { size: 13, fill: MUTED, family: "mono", anchor: "middle" }));
  }
  if (masked) {
    chunks.push(`  <rect x="${maskedX}" y="34" width="${maskedW}" height="28" rx="14" fill="${CHIP}" stroke="${ACCENT}"/>`);
    chunks.push(text(maskedX + maskedW / 2, 53, masked, { size: 13, fill: ACCENT, family: "mono", weight: 700, anchor: "middle" }));
  }
  return chunks.join("\n");
}

function track(beats: { label: string; color: string }[]): string {
  const x0 = 36;
  const y = 78;
  const width = 888;
  const gap = 6;
  if (beats.length === 0) {
    return `  <rect x="${x0}" y="${y}" width="${width}" height="22" rx="6" fill="${TRACK}"/>`;
  }
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
  const transition = testsTransition(summary);
  const only = solePass(summary);
  const outcome = rollupTests(summary.tests);
  const color = outcome === "pass" ? ADD : outcome === "fail" ? REMOVE : MUTED;
  const phrase = transition
    ? `  <text x="48.0" y="${y + 56}" font-family="${MONO}" font-size="18"><tspan fill="${REMOVE}">${transition.failed} failed</tspan><tspan fill="${MUTED}"> → </tspan><tspan fill="${ADD}">${transition.passed}/${transition.total} pass</tspan></text>`
    : text(48, y + 56, only ? `${only.passed}/${only.total} pass` : testsPhrase(summary), {
        size: 18,
        fill: only ? ADD : color,
        family: "mono",
      });
  return [row(y, 78), heading(y, "TESTS RAN", ""), phrase].join("\n");
}

function decisionRow(decision: string): string {
  const y = 312;
  const maxWidth = 848;
  const single = wrapText(decision, maxWidth, 20, 1);
  const oneLineFits = single.length === 1 && single[0] !== undefined && !single[0].endsWith("…") && textWidth(single[0], 20) <= maxWidth;
  const lines = oneLineFits ? single : wrapText(decision, maxWidth, 16, 2);
  const size = oneLineFits ? 20 : 16;
  const start = oneLineFits ? y + 58 : y + 46;
  const step = 22;
  const body = lines.map((line, index) =>
    text(48, start + index * step, line, { size, fill: INK, family: "sans", weight: 700 }),
  );
  return [row(y, 86), heading(y, "KEY DECISION", ""), ...body].join("\n");
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

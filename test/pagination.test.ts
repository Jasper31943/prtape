/**
 * Synthetic pagination shape. Not an authentic Claude Code session.
 * The native run recorded two identical failing `npm test` steps with nothing
 * between them; the session facts say the suite failed once before inspection.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseClaude } from "../src/adapters/claude.js";
import { resolveReadGlobs } from "../src/bash-edits.js";
import { presentSummary, scrubTitle } from "../src/display.js";
import { withSteps } from "../src/summary.js";
import { renderComment } from "../src/timeline/md.js";
import { renderSvg } from "../src/timeline/svg.js";
import { toPublicJson } from "../src/run.js";
import { fixture, trackLabels } from "./helpers.js";

const DECISION = "Fix off-by-one that dropped the last record on a page";
const FALLBACK = "In src/catalog.js, use stored.length instead of stored.length - 1.";

describe("synthetic pagination session", () => {
  const raw = fixture("synthetic-pagination.jsonl");

  it("is labeled synthetic", () => {
    assert.match(raw, /SYNTHETIC anonymized fixture/);
    assert.match(raw, /Not an authentic Claude Code session/);
  });

  it("reads inspected files, keeps one fail, and describes the slice edit", () => {
    const summary = parseClaude(raw, "synthetic-pagination.jsonl");
    const presented = presentSummary(summary);
    const story = presented.summary.steps
      .filter((step) => step.kind !== "prompt" && step.kind !== "decision")
      .map((step) => (step.kind === "test" ? step.outcome : step.kind === "read" ? `read:${step.path ?? ""}` : step.kind));
    assert.deepEqual(story, [
      "fail",
      "read:README.md",
      "read:src",
      "read:test",
      "read:src/catalog.js",
      "read:src/page-query.js",
      "edit",
      "pass",
      "read:",
      "read:",
      "commit",
    ]);
    assert.deepEqual(
      summary.files.map((file) => file.path),
      ["src/catalog.js"],
    );
    assert.equal(presented.summary.title, "Fix the page slice so the last item is included.");
    assert.equal(presented.summary.decision, DECISION);
    assert.equal(presented.summary.decision.includes(": use stored.length"), false);
    assert.equal(normalizeSpace(raw).includes(normalizeSpace(DECISION)), true);
    assertDecisionWordsAreInSession(presented.summary.decision, raw, FALLBACK);
    assert.match(renderComment(summary), /6 failed → 13\/13 pass/);
    const published = toPublicJson(presented.summary) as { steps: { kind: string; path?: string }[] };
    assert.equal(published.steps.some((step) => step.kind === "read" && !step.path), false);
    assert.equal(presented.summary.steps.some((step) => step.kind === "read" && !step.path), true);
    assert.equal(presented.summary.title.includes("pasted_content"), false);
    assert.equal(presented.summary.title.includes("demo"), false);
    const svg = renderSvg(summary);
    assert.match(svg, /#7A8FB0/);
    assert.doesNotMatch(svg, /#33445A/);
    assert.deepEqual(trackLabels(svg), ["fail", "read", "edit", "pass", "commit"]);
    assert.match(svg, /Fix off-by-one that dropped the last record on a page/);
    const json = JSON.stringify(toPublicJson(presented.summary));
    assert.equal(json.includes("\"sessionId\""), false);
    assert.equal(json.includes("synthetic-pagination"), false);
    assert.equal(json.includes("pasted_content"), false);
    assert.equal(json.includes(DECISION), true);
  });
});

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function assertDecisionWordsAreInSession(decision: string, session: string, fallback: string): void {
  const normalizedSession = normalizeSpace(session);
  for (const sentence of decision.split(/(?<=[.!?])\s+/)) {
    const words = normalizeSpace(sentence).replace(/[.!?]+$/g, "");
    if (!words || normalizeSpace(sentence) === normalizeSpace(fallback)) continue;
    assert.equal(normalizedSession.includes(words), true, words);
  }
}

describe("demo label", () => {
  it("draws an outlined Demo project pill and a plain comment tag only when asked", () => {
    const summary = parseClaude(fixture("synthetic-pagination.jsonl"), "synthetic-pagination.jsonl");
    const plain = renderSvg(summary);
    const tagged = renderSvg(summary, {}, true);
    assert.equal(plain.includes("Demo project"), false);
    assert.match(tagged, /Demo project/);
    assert.match(tagged, /fill="none" stroke="#7D8A99"/);
    assert.match(renderComment(summary, {}, undefined, true), /^Demo project$|Demo project\n/m);
    assert.equal(renderComment(summary).includes("Demo project"), false);
  });
});

describe("read globs", () => {
  it("keeps an unresolved pattern instead of inventing files", () => {
    const events = resolveReadGlobs([
      { kind: "read", path: "src/*.js" },
      { kind: "edit", path: "test/catalog.test.js", action: "edit" },
    ]);
    assert.deepEqual(
      events.map((event) => (event.kind === "read" ? event.path : event.kind)),
      ["src/*.js", "edit"],
    );
  });
});

describe("duplicate failing runs", () => {
  it("keeps a second failure that happens after a read", () => {
    const summary = withSteps({
      source: "claude-code",
      sessionId: "synthetic-two-fails",
      title: "Retry the suite.",
      decision: "The tests failed.",
      files: [],
      tests: [],
      events: [
        { kind: "test", command: "npm test", outcome: "fail" },
        { kind: "read", path: "src/catalog.js" },
        { kind: "test", command: "npm test", outcome: "fail" },
      ],
    });
    assert.deepEqual(
      summary.tests.map((test) => test.outcome),
      ["fail", "fail"],
    );
  });
});

describe("pasted title wrappers", () => {
  it("uses the inner sentence and drops an unclosed wrapper", () => {
    assert.equal(
      scrubTitle('<pasted_content id="demo">Fix the page slice so the last item is included.</pasted_content>'),
      "Fix the page slice so the last item is included.",
    );
    assert.equal(
      scrubTitle('<uploaded_documents id="demo">Fix the page slice so the last item is included.'),
      "Fix the page slice so the last item is included.",
    );
    assert.equal(
      scrubTitle("Respond entirely in English. Fix the page slice so the last item is included."),
      "Fix the page slice so the last item is included.",
    );
    assert.equal(
      scrubTitle("This is an intentional AgentTape demo, not a real customer incident. Fix the page slice so the last item is included."),
      "Fix the page slice so the last item is included.",
    );
    assert.equal(scrubTitle("Be concise. Answer in English."), "Be concise.");
    assert.equal(
      scrubTitle(
        "text 請先執行 npm test，確認並保留失敗結果，再修正錯誤。add 應維持一般加法的行為，不要刪除或跳過測試。修完請再次執行 npm test，確認全部通過。",
      ),
      "請先執行 npm test，確認並保留失敗結果，再修正錯誤。",
    );
  });
});

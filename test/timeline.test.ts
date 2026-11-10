import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { parseAider } from "../src/adapters/aider.js";
import { parseClaude } from "../src/adapters/claude.js";
import { asciiFlow, testsPhrase } from "../src/timeline/format.js";
import { renderComment } from "../src/timeline/md.js";
import { renderSvg } from "../src/timeline/svg.js";
import type { SessionSummary } from "../src/types.js";
import { SECRET_CANARIES } from "./canaries.js";
import { fixture, root, trackLabels } from "./helpers.js";

describe("tests row", () => {
  it("shows a counted pass with no icon when nothing failed", () => {
    const summary: SessionSummary = {
      source: "claude-code",
      sessionId: "synthetic-one-pass",
      title: "Run the catalog tests",
      decision: "The suite passed.",
      files: [],
      tests: [{ command: "npm test", outcome: "pass", passed: 13, failed: 0, total: 13 }],
      events: [{ kind: "test", command: "npm test", outcome: "pass", passed: 13, failed: 0, total: 13 }],
      testsRun: true,
      steps: [],
    };
    assert.equal(testsPhrase(summary), "13/13 pass");
    const svg = renderSvg(summary);
    const comment = renderComment(summary);
    assert.match(svg, /fill="#3DDC84"[^>]*>13\/13 pass</);
    assert.doesNotMatch(svg, /→|✓|✔|✕/);
    assert.match(comment, /13\/13 pass/);
    assert.doesNotMatch(comment, /[✓✔✕]/);
    assert.match(comment, /Tests pass/);
  });
});

describe("timeline snapshots", () => {
  it("matches the Claude comment and preview SVG", () => {
    const summary = parseClaude(fixture("claude-session.jsonl"), "claude-session.jsonl");
    const comment = renderComment(summary);
    const svg = renderSvg(summary);
    assert.equal(asciiFlow(summary), "ask ──▶ 3 files ──▶ tests pass ──▶ ship");
    assert.equal(comment, fs.readFileSync(path.join(root, "fixtures", "claude-comment.md"), "utf8"));
    assert.equal(svg, fs.readFileSync(path.join(root, "docs", "preview.svg"), "utf8"));
    assert.doesNotMatch(svg, /<script|foreignObject/i);
    assert.equal(svg.match(/<filter /g)?.length ?? 0, 0);
    assert.equal(svg.match(/<linearGradient /g)?.length, 1);
    assert.match(svg, /width="960"/);
    assert.match(svg, /height="480"/);
    assert.doesNotMatch(svg, />read</);
    assert.match(svg, />edit</);
    assert.doesNotMatch(svg, />fail</);
    assert.doesNotMatch(svg, />fix</);
    assert.match(svg, />pass</);
    assert.doesNotMatch(svg, />commit</);
    assert.deepEqual(trackLabels(svg), ["edit", "pass"]);
    assert.match(svg, /redacted ×16/);
    assert.doesNotMatch(svg, /masked ×/);
    assert.match(svg, /FILES TOUCHED/);
    assert.match(svg, /TESTS RAN/);
    assert.match(svg, /KEY DECISION/);
    assert.match(svg, /npm test · pass/);
    assert.match(svg, /<tspan fill="#E6EDF3">PR<\/tspan><tspan fill="#39FF88">tape<\/tspan>/);
    assert.doesNotMatch(svg, /agent replay/);
    assert.match(svg, /Claude Code/);
    assert.doesNotMatch(svg, /[✓✔✕]/);
    assert.doesNotMatch(comment, /[✓✔✕]/);
    assert.match(svg, /#0B0F14/);
    assert.match(svg, /#39FF88/);
    assert.match(svg, /#22D3EE/);
    assert.match(svg, /Ship the redacted timeline; secrets stay off the PR\./);
    assert.match(svg, /redacted before posting · raw session never uploaded/);
    assert.doesNotMatch(svg, /masked ×\d+ · raw session/);
    assert.doesNotMatch(svg, /\[REDACTED|sk-•|10\.0\./);
    assert.doesNotMatch(comment, /\[REDACTED/);
    for (const block of svg.split("<text").slice(1)) {
      if (!block.includes('fill="#7D8A99"')) continue;
      const size = /font-size="(\d+)"/.exec(block);
      assert.ok(size && Number(size[1]) >= 13);
    }
    for (const canary of SECRET_CANARIES) {
      assert.equal(comment.includes(canary), false);
      assert.equal(svg.includes(canary), false);
    }
  });

  it("matches the Aider comment snapshot", () => {
    const summary = parseAider(fixture("aider-chat-history.md"), "aider-chat-history.md");
    const comment = renderComment(summary);
    assert.equal(asciiFlow(summary), "ask ──▶ 1 file ──▶ tests pass ──▶ ship");
    assert.equal(comment, fs.readFileSync(path.join(root, "fixtures", "aider-comment.md"), "utf8"));
  });
});

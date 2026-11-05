import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAider } from "../src/adapters/aider.js";
import { presentSummary } from "../src/display.js";
import { renderComment } from "../src/timeline/md.js";
import { renderSvg } from "../src/timeline/svg.js";
import { AIDER_LEAK_MARKERS, SECRET_CANARIES } from "./canaries.js";
import { assertMarkersAbsent, assertNoSecrets, fixture } from "./helpers.js";

const raw = fixture("aider-chat-history.md");

describe("Aider adapter", () => {
  it("reads only the latest session and ignores fenced tool lines", () => {
    const summary = parseAider(raw, "aider-chat-history.md");
    assert.equal(summary.source, "aider");
    assert.equal(summary.sessionId, "aider-2026-11-01T15-04-22");
    assert.equal(summary.model, "gpt-4.1");
    assert.equal(summary.startedAt, "2026-11-01T15:04:22");
    assert.match(summary.title, /Strip secrets before posting the timeline/);
    assert.match(summary.decision, /Ship the redacted timeline/);
    assert.deepEqual(summary.files, [{ path: "src/redact.ts", action: "edit" }]);
    assert.equal(summary.testsRun, true);
    assert.equal(summary.tests.length, 1);
    assert.equal(summary.tests[0]?.command, "npm test");
    assert.equal(summary.tests[0]?.outcome, "pass");
  });

  it("renders without secrets, the older session, or the fenced trap", () => {
    const summary = parseAider(raw, "aider-chat-history.md");
    const comment = renderComment(summary);
    const svg = renderSvg(summary);
    const presented = presentSummary(summary);
    const json = JSON.stringify(presented.summary);
    for (const rendered of [comment, svg, json]) {
      assertNoSecrets(rendered, raw);
      assertMarkersAbsent(rendered, AIDER_LEAK_MARKERS);
      assert.equal(rendered.includes("[REDACTED"), false);
    }
    assert.equal(presented.summary.decision, "Ship the redacted timeline.");
    assert.equal(presented.summary.tests[0]?.command, "npm test");
    assert.match(comment, /ask ──▶ 1 file ──▶ tests pass ──▶ ship/);
    assert.match(comment, /npm test · pass/);
    assert.match(svg, /Aider/);
    assert.match(svg, /src\/redact\.ts/);
    for (const canary of SECRET_CANARIES) {
      assert.equal(raw.includes(canary), true, `fixture missing ${canary}`);
    }
  });
});

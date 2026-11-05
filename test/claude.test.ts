import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseClaude } from "../src/adapters/claude.js";
import { presentSummary } from "../src/display.js";
import { renderComment } from "../src/timeline/md.js";
import { renderSvg } from "../src/timeline/svg.js";
import { toPublicJson } from "../src/run.js";
import { ACTIVE_MARKER, CLAUDE_LEAK_MARKERS, EMAIL_CANARY, SECRET_CANARIES } from "./canaries.js";
import { assertMarkersAbsent, assertNoSecrets, fixture } from "./helpers.js";

const raw = fixture("claude-session.jsonl");

describe("Claude Code adapter", () => {
  it("follows the active branch and ignores abandoned, meta, and sidechain records", () => {
    const summary = parseClaude(raw, "claude-session.jsonl");
    assert.equal(summary.source, "claude-code");
    assert.equal(summary.sessionId, "11111111-2222-4333-8444-555555555555");
    assert.equal(summary.branch, "feature/redact-timeline");
    assert.equal(summary.model, "claude-sonnet-4-5");
    assert.equal(summary.startedAt, "2026-11-01T15:04:22.000Z");
    assert.equal(summary.cwd, "/workspace/demo");
    assert.match(summary.title, /Strip keys and internal hosts before posting/);
    assert.match(summary.title, new RegExp(ACTIVE_MARKER));
    assert.match(summary.decision, /^Ship the redacted timeline\./);
    assert.deepEqual(
      summary.files.map((file) => `${file.action} ${file.path}`),
      ["edit src/redact.ts", "edit src/timeline/svg.ts", "write README.md"],
    );
    assert.equal(summary.testsRun, true);
    assert.equal(summary.tests.length, 1);
    assert.equal(summary.tests[0]?.outcome, "pass");
    assert.match(summary.tests[0]?.command ?? "", /npm test$/);
    assert.equal(summary.decision.includes("The redaction patterns now run"), false);
  });

  it("uses the last assistant line when the file has no summary", () => {
    const jsonl = [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        sessionId: "s1",
        message: { role: "user", content: "Fix the flaky queue test." },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: "2026-01-01T00:00:01.000Z",
        sessionId: "s1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The queue drained twice because the ack raced the retry." }],
        },
      }),
    ].join("\n");
    const summary = parseClaude(jsonl, "inline.jsonl");
    assert.equal(summary.title, "Fix the flaky queue test.");
    assert.equal(summary.decision, "The queue drained twice because the ack raced the retry.");
    assert.equal(summary.testsRun, false);
  });

  it("tolerates a broken line and still returns a summary", () => {
    const summary = parseClaude('{"type":"user","message":{"content":"Hello."}}\n{bad\n', "partial.jsonl");
    assert.equal(summary.title, "Hello.");
  });

  it("renders a timeline with no secrets and no discarded markers", () => {
    const summary = parseClaude(raw, "claude-session.jsonl");
    const comment = renderComment(summary);
    const svg = renderSvg(summary);
    const presented = presentSummary(summary);
    const json = JSON.stringify(toPublicJson(presented.summary));
    for (const rendered of [comment, svg, json]) {
      assertNoSecrets(rendered, raw);
      assertMarkersAbsent(rendered, CLAUDE_LEAK_MARKERS);
      assert.equal(rendered.includes("[REDACTED"), false);
      assert.equal(rendered.includes("src/abandoned.ts"), false);
      assert.equal(rendered.includes("src/sidechain-only.ts"), false);
    }
    assert.equal(presented.summary.title, "Strip keys and internal hosts before posting.");
    assert.equal(presented.summary.decision, "Ship the redacted timeline; secrets stay off the PR.");
    assert.equal(presented.summary.tests[0]?.command, "npm test");
    assert.equal(json.includes(EMAIL_CANARY), false);
    assert.equal(json.includes(ACTIVE_MARKER), false);
    assert.match(comment, /ask ──▶ 3 files ──▶ tests pass ──▶ ship/);
    assert.match(comment, /npm test · pass/);
    assert.match(svg, /src\/redact\.ts/);
    assert.match(svg, /npm test · pass/);
    for (const canary of SECRET_CANARIES) {
      assert.equal(raw.includes(canary), true, `fixture missing ${canary}`);
    }
  });
});

/**
 * Synthetic checks. Not an authentic Claude Code session.
 * Chinese and English path sentences are dropped as a unit.
 * The decision follows the edit, not the long status write-up.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { presentSummary, scrubProse } from "../src/display.js";
import { withSteps } from "../src/summary.js";
import type { TimelineEvent } from "../src/types.js";

const SED = "sed -i '' 's/assert.equal(add(2, 2), 5)/assert.equal(add(2, 2), 4)/' math.test.js && npm test";

describe("path-reference sentences", () => {
  it("drops a Chinese locator sentence and keeps the failure evidence", () => {
    const shown = scrubProse(
      [
        "修好了，第二次執行 npm test 全部通過（1 個測試通過，0 個失敗，0 個跳過）。",
        "完整輸出存在 `/private/tmp/claude-501/-Users-patdoe-agenttape-failfix/sess/scratchpad/npm-test-before.log`。",
        "錯的是測試：math.test.js 寫的是 add(2, 2) 應該等於 5。我只把預期值改成 4。",
        "修正後的輸出存在 ``。",
      ].join(""),
    );
    assert.match(shown, /應該等於 5/);
    assert.match(shown, /預期值改成 4/);
    assert.equal(shown.includes("完整輸出存在"), false);
    assert.equal(shown.includes("修正後的輸出存在"), false);
    assert.equal(shown.includes("patdoe"), false);
    assert.equal(shown.includes("`"), false);
  });

  it("drops an English locator sentence and keeps the failure evidence", () => {
    const shown = scrubProse(
      "The tests failed because 4 !== 5. The full output is saved at /private/tmp/claude-9/-Users-patdoe-x/scratchpad/a.log.",
    );
    assert.match(shown, /4 !== 5/);
    assert.equal(shown.includes("saved at"), false);
    assert.equal(shown.includes("patdoe"), false);
    assert.equal(shown.includes("/private/tmp"), false);
    const dangling = scrubProse("The assertion expected 5. The full output is saved at .");
    assert.match(dangling, /expected 5/);
    assert.equal(dangling.includes("saved at"), false);
  });
});

describe("evidence-based decision", () => {
  it("describes a test-expectation edit and does not invent a source fix", () => {
    const presented = presentSummary(session(SED, "修好了，第二次執行 npm test 全部通過。math.js 的 add 回傳 a + b，所以完全沒動。"));
    assert.equal(presented.summary.decision, "Correct test expectation from 5 to 4; leave add() unchanged.");
    assert.doesNotMatch(presented.summary.decision, /return a \+ b|Fix add|回傳/);
  });

  it("uses an observed source return only when that diff is the edit", () => {
    const presented = presentSummary(
      session("npm test", "The tests passed.", [
        {
          kind: "edit",
          path: "math.js",
          action: "edit",
          before: "function add(a, b) {\n  return a - b\n}",
          after: "function add(a, b) {\n  return a + b\n}",
        },
        { kind: "test", command: "npm test", outcome: "pass" },
      ]),
    );
    assert.equal(presented.summary.decision, "Change add() to return a + b.");
  });

  it("does not claim either change when the session edited both", () => {
    const presented = presentSummary(
      session(SED, "The tests passed.", [
        {
          kind: "edit",
          path: "math.js",
          action: "edit",
          before: "function add(a, b) {\n  return a - b\n}",
          after: "function add(a, b) {\n  return a + b\n}",
        },
        { kind: "edit", path: "math.test.js", action: "edit" },
        { kind: "test", command: SED, outcome: "pass" },
      ]),
    );
    assert.doesNotMatch(presented.summary.decision, /return a \+ b|leave add|Correct test expectation/);
    assert.match(presented.summary.decision, /Edited 2 files and the tests passed/);
  });

  it("uses the unwrapped commit subject and does not splice a wrapped line", () => {
    const message = [
      "Fix off-by-one that dropped the last record on a page",
      "",
      "The end index was clamped to stored.length - 1, but slice's end is",
      "exclusive, so the final catalog record was never returned.",
    ].join("\n");
    const presented = presentSummary(
      session("npm test", "Edited the catalog slice and the tests passed.", [
        {
          kind: "edit",
          path: "src/catalog.js",
          action: "edit",
          before: "stored.slice(0, stored.length - 1)",
          after: "stored.slice(0, stored.length)",
        },
        { kind: "commit", message },
      ]),
    );
    assert.equal(presented.summary.decision, "Fix off-by-one that dropped the last record on a page");
    assert.equal(presented.summary.decision.includes(": use stored.length"), false);
    assert.equal(presented.summary.decision.includes("slice's end is:"), false);
    const normalized = message.replace(/\s+/g, " ");
    assert.equal(normalized.includes(presented.summary.decision), true);
  });

  it("keeps a short explicit decision that is not status boilerplate", () => {
    const presented = presentSummary(session("npm test", "Ship the redacted timeline."));
    assert.equal(presented.summary.decision, "Ship the redacted timeline; secrets stay off the PR.");
  });
});

function session(command: string, decision: string, events?: TimelineEvent[]) {
  return withSteps({
    source: "claude-code",
    sessionId: "synthetic-decision",
    title: "Fix the failing assertion.",
    decision,
    files: [],
    tests: [],
    events: events ?? [
      { kind: "read", path: "math.js" },
      { kind: "edit", path: "math.test.js", action: "edit" },
      { kind: "test", command, outcome: "pass" },
    ],
  });
}

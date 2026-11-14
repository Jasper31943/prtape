/**
 * Card layout and public-export regressions. The Chinese decision is a
 * sanitized copy of a real multi-paragraph reply, not an authentic session log.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseClaude } from "../src/adapters/claude.js";
import { cleanDisplayMarkdown, presentSummary, scrubProse } from "../src/display.js";
import { withSteps } from "../src/summary.js";
import { renderSvg } from "../src/timeline/svg.js";
import { textWidth, wrapText } from "../src/timeline/wrap.js";
import { toPublicJson } from "../src/run.js";
import { trackLabels } from "./helpers.js";

const CJK_DECISION = [
  "修好了，第二次執行 `npm test` 全部通過（1 個測試通過，0 個失敗，0 個跳過）。",
  "**修正前的失敗結果**（第一次執行）：",
  "```",
  "not ok 1 - add",
  "Expected values to be strictly equal: 4 !== 5",
  "# tests 1",
  "# pass 0",
  "# fail 1",
  "```",
  "完整輸出存在 ``。",
  "**原因與修正：**",
  "- `math.js` 裡的 `add(a, b)` 回傳 `a + b`，就是一般加法，所以完全沒動。",
  "- 錯的是測試：`math.test.js:6` 寫的是 `add(2, 2)` 應該等於 `5`。我只把預期值改成 `4`，測試沒刪也沒跳過。",
  "修正後的輸出存在 `/private/tmp/claude-501/-Users-patdoe-prtape-failfix/sess/scratchpad/npm-test-after.log`。",
].join("\n");

describe("decision text", () => {
  it("strips markdown and empty backticks left by a deleted private path", () => {
    const shown = scrubProse(CJK_DECISION);
    assert.match(shown, /^修好了，第二次執行 npm test/);
    assert.match(shown, /我只把預期值改成 4/);
    assert.match(shown, /add\(a, b\) 回傳 a \+ b/);
    assert.equal(shown.includes("完整輸出存在"), false);
    assert.equal(shown.includes("修正後的輸出存在"), false);
    assert.equal(shown.includes("`"), false);
    assert.equal(shown.includes("**"), false);
    assert.equal(shown.includes("patdoe"), false);
    assert.equal(shown.includes("/private/tmp"), false);
    assert.equal(shown.includes("```"), false);
    assert.equal(cleanDisplayMarkdown("see `` and ` ` now"), "see and now");
  });

  it("wraps CJK and over-long tokens inside the measured width", () => {
    const cjk = "修好了".repeat(40);
    const token = `token-${"a".repeat(180)}-end`;
    for (const sample of [cjk, token, `${cjk} ${token}`]) {
      const lines = wrapText(sample, 848, 16, 2);
      assert.ok(lines.length >= 1 && lines.length <= 2);
      for (const line of lines) assert.ok(textWidth(line, 16) <= 848, line.slice(0, 24));
    }
    assert.ok(wrapText(cjk, 848, 16, 2).at(-1)?.endsWith("…"));
    const broken = wrapText(token, 200, 16, 2);
    assert.ok(broken.length === 2);
    assert.ok(broken[1]?.endsWith("…"));
    for (const line of broken) assert.ok(textWidth(line, 16) <= 200);
  });

  it("keeps a long Traditional Chinese decision inside the card", () => {
    const summary = withSteps({
      source: "claude-code",
      sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      title: "Fix the addition assertion.",
      decision: `${CJK_DECISION}\n${"a".repeat(240)}`,
      cwd: "/Users/patdoe/prtape-failfix",
      files: [],
      tests: [],
      events: [
        { kind: "test", command: "npm test", outcome: "fail" },
        { kind: "read", path: "math.js" },
        { kind: "edit", path: "math.test.js", action: "edit" },
        {
          kind: "test",
          command: "sed -i '' 's/assert.equal(add(2, 2), 5)/assert.equal(add(2, 2), 4)/' math.test.js && npm test",
          outcome: "pass",
        },
      ],
    });
    const presented = presentSummary(summary);
    const svg = renderSvg(summary);
    const json = JSON.stringify(toPublicJson(presented.summary));
    assert.equal(json.includes("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"), false);
    assert.equal(json.includes("\"sessionId\""), false);
    assert.equal(presented.summary.sessionId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    assert.equal(presented.summary.decision, "Correct test expectation from 5 to 4; leave add() unchanged.");
    assert.equal(svg.includes("`"), false);
    assert.equal(svg.includes("**"), false);
    assert.match(svg, /Correct test expectation from 5 to 4/);
    assert.doesNotMatch(svg, /完整輸出存在|return a \+ b|Fix add/);
    assert.doesNotMatch(svg, />commit</);
    assert.deepEqual(trackLabels(svg), ["fail", "read", "edit", "pass"]);
    assertTextInside(svg);
  });
});

describe("observed commits", () => {
  it("draws a commit only when the session ran git commit", () => {
    const committed = parseClaude(
      [
        line({ type: "user", uuid: "u", message: { role: "user", content: "Ship the fix." } }),
        line({
          type: "assistant",
          uuid: "a",
          parentUuid: "u",
          message: {
            content: [
              { type: "tool_use", id: "t", name: "Bash", input: { command: "npm test && git commit -m \"ship the fix\"" } },
            ],
          },
        }),
        line({
          type: "user",
          uuid: "r",
          parentUuid: "a",
          message: { content: [{ type: "tool_result", tool_use_id: "t", is_error: false, content: "# tests 1\n# pass 1\n# fail 0\n" }] },
        }),
      ].join("\n"),
      "commit.jsonl",
    );
    assert.deepEqual(trackLabels(renderSvg(committed)), ["pass", "commit"]);
    const uncommitted = parseClaude(
      [
        line({ type: "user", uuid: "u", message: { role: "user", content: "Run the tests." } }),
        line({
          type: "assistant",
          uuid: "a",
          parentUuid: "u",
          message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "npm test" } }] },
        }),
        line({
          type: "user",
          uuid: "r",
          parentUuid: "a",
          message: { content: [{ type: "tool_result", tool_use_id: "t", is_error: false, content: "# tests 1\n# pass 1\n# fail 0\n" }] },
        }),
      ].join("\n"),
      "nocommit.jsonl",
    );
    assert.deepEqual(trackLabels(renderSvg(uncommitted)), ["pass"]);
  });
});

function line(value: unknown): string {
  return JSON.stringify(value);
}

function assertTextInside(svg: string): void {
  for (const match of svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"([^>]*)>([^<]*)<\/text>/g)) {
    const x = Number(match[1]);
    const attrs = match[3] ?? "";
    const size = Number(/font-size="(\d+)"/.exec(attrs)?.[1] ?? "13");
    const content = decode(match[4] ?? "");
    if (!content.trim()) continue;
    const width = textWidth(content, size);
    const middle = attrs.includes('text-anchor="middle"');
    const end = attrs.includes('text-anchor="end"');
    const left = middle ? x - width / 2 : end ? x - width : x;
    const right = middle ? x + width / 2 : end ? x : x + width;
    assert.ok(left >= 12, content);
    assert.ok(right <= 944, `${content} ends at ${right.toFixed(1)}`);
  }
}

function decode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

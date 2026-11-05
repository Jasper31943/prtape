import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { parseAider } from "../src/adapters/aider.js";
import { parseClaude } from "../src/adapters/claude.js";
import { asciiFlow } from "../src/timeline/format.js";
import { renderComment } from "../src/timeline/md.js";
import { renderSvg } from "../src/timeline/svg.js";
import { SECRET_CANARIES } from "./canaries.js";
import { fixture, root } from "./helpers.js";

describe("timeline snapshots", () => {
  it("matches the Claude comment and preview SVG", () => {
    const summary = parseClaude(fixture("claude-session.jsonl"), "claude-session.jsonl");
    const comment = renderComment(summary);
    const svg = renderSvg(summary);
    assert.equal(asciiFlow(summary), "ask ──▶ 3 files ──▶ tests pass ──▶ ship");
    assert.equal(comment, fs.readFileSync(path.join(root, "fixtures", "claude-comment.md"), "utf8"));
    assert.equal(svg, fs.readFileSync(path.join(root, "docs", "preview.svg"), "utf8"));
    assert.doesNotMatch(svg, /<script|foreignObject/i);
    assert.equal(svg.match(/<filter /g)?.length, 1);
    assert.equal(svg.match(/<linearGradient /g)?.length, 1);
    assert.match(svg, /#0B0F14/);
    assert.match(svg, /#39FF88/);
    assert.match(svg, /#22D3EE/);
    assert.doesNotMatch(svg, /#f3efe6|#fbf8f2|#1c1714/i);
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

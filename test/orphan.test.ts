import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { glancePushDenied, isPermissionFailure } from "../src/glance.js";
import { ORPHAN_FILE, pushOrphanPng } from "../src/orphan.js";
import { renderComment } from "../src/timeline/md.js";
import { parseClaude } from "../src/adapters/claude.js";
import { fixture } from "./helpers.js";

describe("orphan PNG branch", () => {
  it("names the permission failure and the fix in one glance", () => {
    const glance = glancePushDenied();
    assert.match(glance, /Image not posted/);
    assert.match(glance, /agenttape-media/);
    assert.match(glance, /Fix:/);
    assert.match(glance, /write access/);
    assert.match(glance, /ASCII \+ mermaid/);
    assert.equal(isPermissionFailure("remote: Permission to acme/demo.git denied to octocat."), true);
    assert.equal(isPermissionFailure("fatal: couldn't find remote ref agenttape-media"), false);
  });

  it("pushes timeline.png onto an orphan branch without touching the project", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "agenttape-proj-"));
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "agenttape-bare-"));
    git(bare, ["init", "--bare"]);
    const before = fs.readdirSync(project);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const first = pushOrphanPng({ remote: bare, png, tmpRoot: os.tmpdir() });
    assert.equal(first.ok, true, "glance" in first ? first.glance : "");
    if (!first.ok) return;
    const second = pushOrphanPng({
      remote: bare,
      png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
      tmpRoot: os.tmpdir(),
    });
    assert.equal(second.ok, true, "glance" in second ? second.glance : "");
    if (!second.ok) return;
    assert.notEqual(first.sha, second.sha);
    const shown = git(bare, ["ls-tree", "--name-only", second.sha]);
    assert.match(shown, new RegExp(ORPHAN_FILE));
    assert.deepEqual(fs.readdirSync(project), before);
    assert.equal(fs.existsSync(path.join(project, ".agenttape")), false);
  });

  it("puts the raw URL and both visibility cases on an image comment", () => {
    const summary = parseClaude(fixture("claude-session.jsonl"), "claude-session.jsonl");
    const url = "https://github.com/acme/demo/raw/abc123def/timeline.png";
    const comment = renderComment(summary, {}, { url, isPrivate: true });
    assert.match(comment, /github\.com\/acme\/demo\/raw\/abc123def\/timeline\.png/);
    assert.match(comment, /public repo/i);
    assert.match(comment, /private repo/i);
    assert.match(comment, /logged-out users, email notifications, and some mobile clients/);
    assert.match(comment, /```mermaid/);
    assert.match(comment, /ask ──▶ 3 files ──▶ tests pass ──▶ ship/);
  });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

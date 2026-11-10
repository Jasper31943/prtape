import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { glancePushDenied, isPermissionFailure, orphanRef } from "../src/glance.js";
import { ORPHAN_FILE, pushOrphanPng } from "../src/orphan.js";
import { renderComment } from "../src/timeline/md.js";
import { parseClaude } from "../src/adapters/claude.js";
import { fixture } from "./helpers.js";

describe("orphan PNG ref", () => {
  it("PRTAPE_DENY_PUSH forces the mermaid fallback without pushing", () => {
    const previous = process.env.PRTAPE_DENY_PUSH;
    const legacy = process.env.AGENTTAPE_DENY_PUSH;
    process.env.PRTAPE_DENY_PUSH = "1";
    delete process.env.AGENTTAPE_DENY_PUSH;
    try {
      const result = pushOrphanPng({ remote: "/tmp/prtape-should-not-push", png: Buffer.from("png") });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.glance, /refs\/prtape\/<sha>/);
        assert.match(result.glance, /prtape pr/);
      }
    } finally {
      if (previous === undefined) delete process.env.PRTAPE_DENY_PUSH;
      else process.env.PRTAPE_DENY_PUSH = previous;
      if (legacy === undefined) delete process.env.AGENTTAPE_DENY_PUSH;
      else process.env.AGENTTAPE_DENY_PUSH = legacy;
    }
  });

  it("AGENTTAPE_DENY_PUSH forces the mermaid fallback without pushing", () => {
    const previous = process.env.AGENTTAPE_DENY_PUSH;
    process.env.AGENTTAPE_DENY_PUSH = "1";
    try {
      const result = pushOrphanPng({ remote: "/tmp/agenttape-should-not-push", png: Buffer.from("png") });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.glance, /was denied/);
        assert.match(result.glance, /ASCII \+ mermaid/);
      }
    } finally {
      if (previous === undefined) delete process.env.AGENTTAPE_DENY_PUSH;
      else process.env.AGENTTAPE_DENY_PUSH = previous;
    }
  });

  it("names the permission failure and the fix in one glance", () => {
    const glance = glancePushDenied();
    assert.match(glance, /Image not posted/);
    assert.match(glance, /refs\/prtape\/<sha>/);
    assert.match(glance, /Fix:/);
    assert.match(glance, /write access/);
    assert.match(glance, /ASCII \+ mermaid/);
    assert.equal(isPermissionFailure("remote: Permission to acme/demo.git denied to octocat."), true);
    assert.equal(orphanRef("abc123def"), "refs/prtape/abc123def");
  });

  it("pushes a parentless commit to refs/agenttape/<head> and leaves the project untouched", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "agenttape-proj-"));
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "agenttape-bare-"));
    git(bare, ["init", "--bare"]);
    git(project, ["init", "-b", "main"]);
    git(project, ["config", "user.email", "agenttape@localhost"]);
    git(project, ["config", "user.name", "AgentTape"]);
    fs.writeFileSync(path.join(project, "README.md"), "project\n");
    git(project, ["add", "README.md"]);
    git(project, ["commit", "-m", "init"]);
    const head = git(project, ["rev-parse", "HEAD"]).trim();
    const statusBefore = git(project, ["status", "--porcelain"]);
    const refsBefore = git(project, ["for-each-ref"]);

    const first = pushOrphanPng({
      remote: bare,
      png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      anchor: head,
      tmpRoot: os.tmpdir(),
    });
    assert.equal(first.ok, true, "glance" in first ? first.glance : "");
    if (!first.ok) return;
    assert.equal(first.ref, `refs/prtape/${head}`);
    assert.throws(() => git(bare, ["rev-parse", "--verify", `${first.sha}^`]));
    assert.deepEqual(
      git(bare, ["ls-tree", "--name-only", first.sha]).trim().split("\n").filter(Boolean),
      [ORPHAN_FILE],
    );
    assert.equal(git(bare, ["rev-parse", first.ref]).trim(), first.sha);
    assert.equal(git(bare, ["for-each-ref", "--format=%(refname)", "refs/heads"]).includes("prtape"), false);

    const second = pushOrphanPng({
      remote: bare,
      png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
      anchor: head,
      tmpRoot: os.tmpdir(),
    });
    assert.equal(second.ok, true, "glance" in second ? second.glance : "");
    if (!second.ok) return;
    assert.notEqual(first.sha, second.sha);
    assert.equal(git(bare, ["rev-parse", second.ref]).trim(), second.sha);

    assert.equal(git(project, ["rev-parse", "HEAD"]).trim(), head);
    assert.equal(git(project, ["status", "--porcelain"]), statusBefore);
    assert.equal(git(project, ["for-each-ref"]), refsBefore);
    assert.equal(fs.existsSync(path.join(project, ".prtape")), false);
  });

  it("leads the hosted comment with the raw image and keeps ASCII for the fallback only", () => {
    const summary = parseClaude(fixture("claude-session.jsonl"), "claude-session.jsonl");
    const url = "https://github.com/acme/demo/raw/abc123def/timeline.png";
    const comment = renderComment(summary, {}, { url, isPrivate: false });
    assert.match(comment, /^!\[PRtape timeline\]\(https:\/\/github\.com\/acme\/demo\/raw\/abc123def\/timeline\.png\)/);
    assert.match(comment, /<!-- prtape -->/);
    assert.match(comment, /public repo/i);
    assert.match(comment, /private repo/i);
    assert.match(comment, /logged-out users, email notifications, and some mobile clients/);
    assert.match(comment, /\*\*Ship the redacted timeline/);
    assert.doesNotMatch(comment, /```mermaid/);
    assert.doesNotMatch(comment, /ask ──▶/);
    assert.doesNotMatch(comment, /raw\.githubusercontent\.com/);

    const fallback = renderComment(summary);
    assert.match(fallback, /```mermaid/);
    assert.match(fallback, /ask ──▶ 3 files ──▶ tests pass ──▶ ship/);
    assert.doesNotMatch(fallback, /!\[PRtape timeline\]/);
    assert.match(fallback, /### PRtape/);
    assert.match(fallback, /<!-- prtape -->/);
  });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

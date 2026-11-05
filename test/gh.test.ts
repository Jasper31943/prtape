import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { explainGhFailure, postComment, type CommandResult, type CommandRunner } from "../src/gh.js";
import { runPr } from "../src/run.js";
import { SECRET_CANARIES } from "./canaries.js";
import { root } from "./helpers.js";

function result(partial: Partial<CommandResult>): CommandResult {
  return { code: partial.code ?? 1, stdout: partial.stdout ?? "", stderr: partial.stderr ?? "" };
}

describe("gh", () => {
  it("explains a missing binary, a missing login, and a missing PR", () => {
    assert.match(explainGhFailure(result({ code: 127, stderr: "gh not found" })), /not installed/);
    assert.match(explainGhFailure(result({ stderr: "gh auth login required" })), /not authenticated/);
    assert.match(explainGhFailure(result({ stderr: "no pull requests found for branch" })), /No pull request/);
  });

  it("posts the redacted body on stdin and does not call gh during --dry-run", async () => {
    const calls: { args: string[]; input?: string }[] = [];
    const runner: CommandRunner = async (_command, args, options) => {
      calls.push({ args, input: options.input });
      if (args[1] === "view") {
        return result({
          code: 0,
          stdout: JSON.stringify({ number: 12, url: "https://github.com/acme/demo/pull/12" }),
        });
      }
      return result({ code: 0, stdout: "" });
    };

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agenttape-pr-"));
    const before = fs.readdirSync(cwd);
    const session = path.join(root, "fixtures", "claude-session.jsonl");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttape-svg-"));

    const dry = await runPr({
      cwd,
      sessionPath: session,
      source: "auto",
      dryRun: true,
      redactEmails: false,
      tmpDir,
      runner,
      hostImage: () => {
        throw new Error("dry-run must not host the PNG");
      },
    });
    assert.equal(dry.posted, false);
    assert.equal(calls.length, 0);
    assert.deepEqual(fs.readdirSync(cwd), before);
    assert.equal(fs.existsSync(path.join(cwd, ".agenttape")), false);
    assert.equal(fs.existsSync(dry.svgPath), true);
    assert.ok(dry.svgPath.startsWith(tmpDir));
    assert.equal(fs.readFileSync(dry.svgPath, "utf8"), dry.svg);
    assert.equal((fs.statSync(dry.svgPath).mode & 0o777) === 0o600, true);

    calls.length = 0;
    const imageUrl = "https://github.com/acme/demo/raw/abc123def/timeline.png";
    const posted = await runPr({
      cwd,
      sessionPath: session,
      source: "auto",
      dryRun: false,
      redactEmails: false,
      tmpDir,
      runner,
      hostImage: async () => ({
        ok: true,
        url: imageUrl,
        sha: "abc123def",
        ref: "refs/agenttape/abc123def",
        isPrivate: false,
      }),
    });
    assert.equal(posted.posted, true);
    assert.equal(posted.imageHosted, true);
    assert.equal(posted.prNumber, 12);
    const commentCall = calls.find((call) => call.args[1] === "comment");
    assert.ok(commentCall);
    assert.equal(commentCall?.args.includes("--body-file"), true);
    assert.match(commentCall?.input ?? "", /^!\[AgentTape timeline\]\(https:\/\/github\.com\/acme\/demo\/raw\/abc123def\/timeline\.png\)/);
    assert.match(commentCall?.input ?? "", /github\.com\/acme\/demo\/raw\/abc123def\/timeline\.png/);
    assert.doesNotMatch(commentCall?.input ?? "", /```mermaid/);
    assert.doesNotMatch(commentCall?.input ?? "", /ask ──▶/);
    assert.match(commentCall?.input ?? "", /\*\*Ship the redacted timeline/);
    assert.match(commentCall?.input ?? "", /private repo/i);
    assert.match(posted.note, /hosted PNG/);
    for (const canary of SECRET_CANARIES) {
      assert.equal(commentCall?.input?.includes(canary), false, canary);
      assert.equal(posted.comment.includes(canary), false);
      assert.equal(posted.svg.includes(canary), false);
    }
    assert.deepEqual(fs.readdirSync(cwd), before);
  });

  it("returns the comment instead of throwing when gh cannot find a PR", async () => {
    const runner: CommandRunner = async () => result({ code: 1, stderr: "no pull requests found for branch" });
    const thrown = await postComment(process.cwd(), "hello", runner).then(
      () => {
        throw new Error("expected failure");
      },
      (error: unknown) => error,
    );
    assert.ok(thrown instanceof Error);
    assert.match(thrown.message, /No pull request/);

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agenttape-nopr-"));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttape-svg-"));
    const kept = await runPr({
      cwd,
      sessionPath: path.join(root, "fixtures", "claude-session.jsonl"),
      source: "auto",
      dryRun: false,
      redactEmails: false,
      tmpDir,
      runner,
      hostImage: async () => ({
        ok: false,
        glance: [
          "Image not posted: push to orphan ref refs/agenttape/<sha> was denied.",
          "Fix: give this account write access to the repo, then rerun `agenttape pr`.",
          "Fell back to the text timeline (ASCII + mermaid).",
        ].join("\n"),
      }),
    });
    assert.equal(kept.posted, false);
    assert.equal(kept.imageHosted, false);
    assert.match(kept.note, /was denied/);
    assert.match(kept.note, /write access/);
    assert.match(kept.note, /No pull request/);
    assert.match(kept.note, /Nothing was posted/);
    assert.match(kept.comment, /```mermaid/);
    assert.equal(kept.comment.includes("github.com/"), false);
    assert.equal(fs.readdirSync(cwd).some((name) => name === ".agenttape" || name.endsWith(".jsonl")), false);
  });

  it("prints a one-glance fix and does not post when gh is missing", async () => {
    let comments = 0;
    const runner: CommandRunner = async (_command, args) => {
      if (args[0] === "pr" && args[1] === "comment") comments += 1;
      return result({ code: 127, stderr: "gh not found" });
    };
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agenttape-nogh-"));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttape-svg-"));
    const out = await runPr({
      cwd,
      sessionPath: path.join(root, "fixtures", "claude-session.jsonl"),
      source: "auto",
      dryRun: false,
      redactEmails: false,
      tmpDir,
      runner,
    });
    assert.equal(out.posted, false);
    assert.equal(out.imageHosted, false);
    assert.equal(comments, 0);
    assert.match(out.note, /gh is not installed/);
    assert.match(out.note, /gh auth login/);
    assert.match(out.note, /ASCII \+ mermaid/);
    assert.match(out.note, /Nothing was posted/);
    assert.match(out.comment, /```mermaid/);
    assert.equal(out.comment.includes("/raw/"), false);
  });
});

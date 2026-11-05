import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SECRET_CANARIES } from "./canaries.js";
import { root } from "./helpers.js";

const require = createRequire(import.meta.url);

function tsxImport(): string {
  const entry = require.resolve("tsx");
  return path.join(path.dirname(entry), "esm", "index.mjs");
}

function run(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const cli = path.join(root, "src", "cli.ts");
  const result = spawnSync(process.execPath, ["--import", tsxImport(), cli, ...args], {
    cwd,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("cli", () => {
  it("prints a redacted dry-run comment and writes the SVG outside the project", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agenttape-cli-"));
    const session = path.join(root, "fixtures", "claude-session.jsonl");
    const result = run(["pr", "--dry-run", "--session", session, "--cwd", cwd], cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /### AgentTape/);
    assert.match(result.stdout, /ask ──▶ 3 files ──▶ tests pass ──▶ ship/);
    assert.match(result.stderr, /dry-run/);
    assert.match(result.stderr, /SVG: /);
    const svgPath = /SVG: (.+)/.exec(result.stderr)?.[1]?.trim();
    assert.ok(svgPath);
    assert.equal(svgPath.startsWith(cwd), false);
    assert.match(fs.readFileSync(svgPath, "utf8"), /<svg/);
    assert.equal(fs.readdirSync(cwd).length, 0);
    for (const canary of SECRET_CANARIES) {
      assert.equal(result.stdout.includes(canary), false, canary);
      assert.equal(result.stderr.includes(canary), false, canary);
      assert.equal(fs.readFileSync(svgPath, "utf8").includes(canary), false, canary);
    }
  });

  it("keeps stdout to the JSON document when --json is set", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agenttape-json-"));
    const session = path.join(root, "fixtures", "aider-chat-history.md");
    const result = run(["pr", "--json", "--dry-run", "--session", session, "--cwd", cwd], cwd);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as { testsRun: boolean; source: string; decision: string; title: string };
    assert.equal(parsed.source, "aider");
    assert.equal(parsed.testsRun, true);
    assert.match(parsed.decision, /\[REDACTED_GITHUB_TOKEN\]/);
    assert.equal(result.stdout.includes("### AgentTape"), false);
    for (const canary of SECRET_CANARIES) {
      assert.equal(result.stdout.includes(canary), false, canary);
    }
    assert.equal(fs.readdirSync(cwd).length, 0);
  });

  it("prints the version", () => {
    const result = run(["--version"], root);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "0.1.0");
  });

  it("exits 1 when the session file is missing", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agenttape-missing-"));
    const result = run(["pr", "--session", path.join(cwd, "no-such.jsonl"), "--cwd", cwd], cwd);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not found/);
  });
});

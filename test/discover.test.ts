import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  claudeProjectSlug,
  defaultClaudeHome,
  findAiderHistory,
  findSession,
  listClaudeSessions,
  NoSessionError,
  selectClaudeSession,
} from "../src/discover.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agenttape-discover-"));
}

function writeSession(home: string, slug: string, name: string, cwd: string, touched: string): string {
  const dir = path.join(home, "projects", slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const line = {
    type: "assistant",
    uuid: "u1",
    parentUuid: null,
    timestamp: "2026-11-01T00:00:00.000Z",
    sessionId: name.replace(/\.jsonl$/, ""),
    cwd,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Edited a file." },
        { type: "tool_use", id: "t1", name: "Edit", input: { file_path: touched } },
      ],
    },
  };
  fs.writeFileSync(file, `${JSON.stringify(line)}\n`);
  return file;
}

describe("discovery", () => {
  it("encodes a project slug without decoding it back", () => {
    assert.equal(claudeProjectSlug("/workspace/demo"), "-workspace-demo");
  });

  it("uses CLAUDE_CONFIG_DIR when it is set", () => {
    assert.equal(defaultClaudeHome({ CLAUDE_CONFIG_DIR: "/tmp/claude-config" }, "/home/someone"), "/tmp/claude-config");
    assert.equal(defaultClaudeHome({}, "/home/someone"), path.join("/home/someone", ".claude"));
  });

  it("picks the newest session whose cwd matches, not a newer unrelated file", () => {
    const root = tempDir();
    const home = path.join(root, "claude");
    const older = writeSession(home, "-workspace-demo", "old.jsonl", "/workspace/demo", "src/old.ts");
    const newerRelated = writeSession(home, "-workspace-demo", "new.jsonl", "/workspace/demo", "src/new.ts");
    const unrelated = writeSession(home, "-other-app", "other.jsonl", "/other/app", "src/other.ts");
    const sub = path.join(home, "projects", "-workspace-demo", "new", "subagents");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "agent.jsonl"), "{}\n");
    const now = Date.now();
    fs.utimesSync(older, now / 1000 - 50, now / 1000 - 50);
    fs.utimesSync(newerRelated, now / 1000 - 20, now / 1000 - 20);
    fs.utimesSync(unrelated, now / 1000, now / 1000);

    const listed = listClaudeSessions(home);
    assert.equal(listed.length, 3);
    assert.equal(selectClaudeSession(listed, "/workspace/demo"), newerRelated);
  });

  it("falls back to a session that edited the files git reports as changed", () => {
    const root = tempDir();
    const home = path.join(root, "claude");
    const match = writeSession(home, "-other-app", "match.jsonl", "/other/app", "src/app.ts");
    writeSession(home, "-elsewhere", "miss.jsonl", "/elsewhere", "src/unrelated.ts");
    const chosen = selectClaudeSession(listClaudeSessions(home), "/workspace/demo", ["src/app.ts"]);
    assert.equal(chosen, match);
    assert.equal(selectClaudeSession(listClaudeSessions(home), "/workspace/demo", []), null);
  });

  it("finds Aider history in a parent directory", () => {
    const root = tempDir();
    const nested = path.join(root, "a", "b");
    fs.mkdirSync(nested, { recursive: true });
    const history = path.join(root, ".aider.chat.history.md");
    fs.writeFileSync(history, "# aider chat started at 2026-01-01 00:00:00\n\n#### Hi\n");
    assert.equal(findAiderHistory(nested), history);
    assert.equal(findAiderHistory(tempDir()), null);
  });

  it("chooses the newer of Claude and Aider in auto mode", () => {
    const root = tempDir();
    const home = path.join(root, "claude");
    const project = path.join(root, "repo");
    fs.mkdirSync(project, { recursive: true });
    const claude = writeSession(home, claudeProjectSlug(project), "s.jsonl", project, "src/app.ts");
    const aider = path.join(project, ".aider.chat.history.md");
    fs.writeFileSync(aider, "# aider chat started at 2026-01-01 00:00:00\n\n#### Hi\n");
    const now = Date.now();
    fs.utimesSync(claude, now / 1000 - 30, now / 1000 - 30);
    fs.utimesSync(aider, now / 1000, now / 1000);
    const found = findSession({ cwd: project, source: "auto", claudeHome: home, recentFiles: [] });
    assert.equal(found.source, "aider");
    assert.match(found.note ?? "", /newer/);
  });

  it("errors when nothing relevant is on disk", () => {
    const root = tempDir();
    assert.throws(
      () => findSession({ cwd: root, source: "auto", claudeHome: path.join(root, "missing"), recentFiles: [] }),
      NoSessionError,
    );
  });
});

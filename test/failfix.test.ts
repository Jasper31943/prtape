/**
 * Synthetic anonymized regressions for the fail-then-fix session shape.
 * This is not an authentic Claude Code log and must not be described as one.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseClaude } from "../src/adapters/claude.js";
import { bashEvents, bashFileEdits } from "../src/bash-edits.js";
import { presentSummary } from "../src/display.js";
import { stripPrivatePaths } from "../src/privacy.js";
import { withSteps } from "../src/summary.js";
import { renderComment } from "../src/timeline/md.js";
import { renderSvg } from "../src/timeline/svg.js";
import { testsPhrase } from "../src/timeline/format.js";
import { classifyTestOutput, isTestCommand } from "../src/tests-detect.js";
import { toPublicJson } from "../src/run.js";
import { fixture, trackLabels } from "./helpers.js";

const TAP_FAIL = "not ok 1 - add\n  message: 4 !== 5\n# tests 1\n# pass 0\n# fail 1\n# skipped 0\n";
const TAP_PASS = "ok 1 - add\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n";
const TEE = "/private/tmp/claude-501/-Users-patdoe-agenttape-failfix/sess/scratchpad/npm-test-before.log";

const PRIVATE_MARKERS = [
  "/Users/patdoe",
  "/home/patdoe",
  "/private/tmp",
  "/tmp/claude",
  "-Users-patdoe",
  "scratchpad",
  "claude-501",
  "patdoe",
];

describe("Node TAP outcomes", () => {
  it("reads the summary counts and does not treat a tee pipeline as a pass", () => {
    assert.equal(classifyTestOutput(TAP_FAIL, false), "fail");
    assert.equal(classifyTestOutput(TAP_PASS, false), "pass");
    assert.equal(classifyTestOutput("tee wrote the log\n", false), "unknown");
    assert.equal(classifyTestOutput("", true), "fail");
    assert.equal(classifyTestOutput(TAP_FAIL, true), "fail");
    assert.equal(isTestCommand(`ls -la && cat package.json && npm test 2>&1 | tee ${TEE}`), true);
    assert.equal(isTestCommand("ls -la && cat package.json"), false);
  });
});

describe("conservative Bash edits", () => {
  it("counts in-place sed, perl, and project redirects", () => {
    assert.deepEqual(
      bashFileEdits("sed -i '' 's/assert.equal(add(2, 2), 5)/assert.equal(add(2, 2), 4)/' math.test.js"),
      [{ path: "math.test.js", action: "edit" }],
    );
    assert.deepEqual(bashFileEdits("sed -i 's/a/b/' math.test.js"), [{ path: "math.test.js", action: "edit" }]);
    assert.deepEqual(bashFileEdits("sed -i.bak 's/a/b/' math.test.js"), [{ path: "math.test.js", action: "edit" }]);
    assert.deepEqual(bashFileEdits("sed 's/a/b/' math.test.js"), []);
    assert.deepEqual(bashFileEdits("perl -pi -e 's/a/b/' lib/add.js"), [{ path: "lib/add.js", action: "edit" }]);
    assert.deepEqual(bashFileEdits("perl -i -pe 's/a/b/' lib/add.js"), [{ path: "lib/add.js", action: "edit" }]);
    assert.deepEqual(bashFileEdits("perl -pe 's/a/b/' lib/add.js"), []);
    assert.deepEqual(bashFileEdits("echo note > src/note.txt"), [{ path: "src/note.txt", action: "write" }]);
    assert.deepEqual(bashFileEdits("echo note >> src/note.txt"), [{ path: "src/note.txt", action: "write" }]);
  });

  it("keeps edit and test order inside one command and does not invent a commit", () => {
    const tee = "/private/tmp/claude-501/-Users-patdoe-agenttape-failfix/sess/scratchpad/npm-test-before.log";
    assert.deepEqual(
      bashEvents(`ls -la && cat package.json && npm test 2>&1 | tee ${tee}`).map((event) => event.kind),
      ["test"],
    );
    assert.deepEqual(
      bashEvents("cat math.js && cat math.test.js").map((event) => event.kind),
      ["read", "read"],
    );
    assert.deepEqual(
      bashEvents("sed -i '' 's/assert.equal(add(2, 2), 5)/assert.equal(add(2, 2), 4)/' math.test.js && cat math.test.js && npm test").map(
        (event) => event.kind,
      ),
      ["edit", "test"],
    );
    assert.deepEqual(
      bashEvents("npm test && sed -i 's/a/b/' math.test.js").map((event) => event.kind),
      ["test", "edit"],
    );
    assert.deepEqual(bashEvents('git commit -m "ship the fix"').map((event) => event.kind), ["commit"]);
  });

  it("ignores reads, tee capture, and scratch redirects", () => {
    const command = `ls -la && cat package.json && npm test 2>&1 | tee ${TEE}`;
    assert.deepEqual(bashFileEdits(command), []);
    assert.deepEqual(bashFileEdits("cat math.js && cat math.test.js"), []);
    assert.deepEqual(bashFileEdits(`echo x > ${TEE}`), []);
    assert.deepEqual(bashFileEdits("echo x > /dev/null"), []);
    assert.deepEqual(bashFileEdits("sed -i '' 's/a/b/' /tmp/claude-9/scratchpad/log"), []);
  });
});

describe("private path deletion", () => {
  it("removes macOS and Linux homes and encoded Claude scratch slugs", () => {
    assert.equal(stripPrivatePaths("checkout /Users/patdoe/proj/math.js"), "checkout /proj/math.js");
    assert.equal(stripPrivatePaths("checkout /home/patdoe/proj/math.js"), "checkout /proj/math.js");
    assert.equal(stripPrivatePaths(`log ${TEE}`), "log");
    assert.equal(stripPrivatePaths("slug -Users-patdoe-agenttape-failfix tail"), "slug agenttape-failfix tail");
    const presented = presentSummary(
      withSteps({
        source: "claude-code",
        sessionId: "synthetic",
        cwd: "/home/patdoe/proj",
        title: "Fix /home/patdoe/proj/math.js now.",
        decision: "Ship it from /Users/patdoe/proj.",
        files: [{ path: "/home/patdoe/proj/lib/add.js", action: "edit" }],
        tests: [{ command: `npm test 2>&1 | tee ${TEE}`, outcome: "pass" }],
      }),
    );
    const json = JSON.stringify(toPublicJson(presented.summary));
    assert.equal(presented.summary.title, "Fix /proj/math.js now.");
    assert.equal(presented.summary.cwd, "/proj");
    assert.equal(presented.summary.files[0]?.path, "proj/lib/add.js");
    assert.equal(presented.summary.tests[0]?.command, "npm test");
    for (const marker of PRIVATE_MARKERS) assert.equal(json.includes(marker), false, marker);
  });
});

describe("synthetic fail-then-fix session", () => {
  const raw = fixture("synthetic-failfix.jsonl");

  it("is labeled synthetic and is not the authentic session", () => {
    assert.match(raw, /SYNTHETIC anonymized fixture/);
    assert.match(raw, /Not an authentic Claude Code session/);
    assert.equal(raw.includes("2.1.319"), false);
  });

  it("keeps the failed run, the sed edit, and the final pass", () => {
    const summary = parseClaude(raw, "synthetic-failfix.jsonl");
    assert.deepEqual(
      summary.files.map((file) => `${file.action} ${file.path}`),
      ["edit math.test.js"],
    );
    assert.deepEqual(
      summary.tests.map((test) => test.outcome),
      ["fail", "pass"],
    );
    const presented = presentSummary(summary);
    const comment = renderComment(summary);
    const svg = renderSvg(summary);
    const json = JSON.stringify(toPublicJson(presented.summary));
    assert.equal(testsPhrase(presented.summary), "npm test · pass");
    assert.deepEqual(
      presented.summary.steps
        .filter((step) => step.kind !== "prompt" && step.kind !== "decision")
        .map((step) => (step.kind === "test" ? step.outcome : step.kind)),
      ["fail", "read", "read", "read", "edit", "pass"],
    );
    assert.deepEqual(trackLabels(svg), ["fail", "read", "edit", "pass"]);
    assert.match(comment, /npm test · pass/);
    assert.match(comment, /· fail/);
    assert.match(comment, /· pass/);
    assert.doesNotMatch(svg, />fix</);
    assert.doesNotMatch(svg, />commit</);
    assert.match(svg, /math\.test\.js/);
    assert.match(svg, /npm test · pass/);
    assert.doesNotMatch(svg, /npm test · fail/);
    for (const rendered of [comment, svg, json]) {
      assert.equal(rendered.includes("[REDACTED"), false);
      for (const marker of PRIVATE_MARKERS) {
        assert.equal(rendered.includes(marker), false, marker);
      }
    }
  });
});

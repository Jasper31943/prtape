import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REDACTED_API_KEY,
  REDACTED_AWS_KEY,
  REDACTED_DATABASE_URL,
  REDACTED_EMAIL,
  REDACTED_GITHUB_TOKEN,
  REDACTED_HOST,
  REDACTED_IP,
  REDACTED_PASSWORD,
  redact,
} from "../src/redact.js";
import { presentSummary } from "../src/display.js";
import { withSteps } from "../src/summary.js";
import { toPublicJson } from "../src/run.js";
import { renderComment } from "../src/timeline/md.js";
import { renderSvg } from "../src/timeline/svg.js";
import { renderPng } from "../src/png.js";
import { EMAIL_CANARY, SECRET_CANARIES } from "./canaries.js";

describe("redact", () => {
  it("replaces every default secret class and leaves ordinary text", () => {
    const awsSecret = "AWS_SECRET_VALUE_CANARY_0123456789abcd";
    const input = [
      "Ship src/redact.ts on port 3000 at example.com.",
      // A bare 40-character secret is not identifiable. The assigned form is.
      ...SECRET_CANARIES.filter((canary) => canary !== awsSecret),
      `AWS_SECRET_ACCESS_KEY=${awsSecret}`,
      EMAIL_CANARY,
      "localhost stays, and so does 8.8.8.8, 172.15.1.1, 172.32.0.1, and 192.169.1.1.",
    ].join(" ");
    const output = redact(input);

    for (const canary of SECRET_CANARIES) {
      assert.equal(output.includes(canary), false, canary);
    }
    assert.equal(output.includes(EMAIL_CANARY), false);
    assert.match(output, new RegExp(escapeReg(REDACTED_API_KEY)));
    assert.match(output, new RegExp(escapeReg(REDACTED_GITHUB_TOKEN)));
    assert.match(output, new RegExp(escapeReg(REDACTED_AWS_KEY)));
    assert.match(output, new RegExp(escapeReg(REDACTED_IP)));
    assert.match(output, new RegExp(escapeReg(REDACTED_HOST)));
    assert.match(output, /src\/redact\.ts/);
    assert.match(output, /example\.com/);
    assert.match(output, /localhost/);
    assert.match(output, /8\.8\.8\.8/);
    assert.match(output, /172\.15\.1\.1/);
    assert.match(output, /172\.32\.0\.1/);
    assert.match(output, /192\.169\.1\.1/);
    assert.match(output, new RegExp(escapeReg(REDACTED_EMAIL)));
  });

  it("keeps an email only when redaction is turned off", () => {
    const output = redact(`ping ${EMAIL_CANARY}`, { emails: false });
    assert.equal(output.includes(EMAIL_CANARY), true);
    assert.equal(output.includes(REDACTED_EMAIL), false);
  });

  it("is stable when run twice", () => {
    const once = redact(SECRET_CANARIES.join(" "));
    assert.equal(redact(once), once);
  });

  it("prefers the Anthropic prefix over generic sk-", () => {
    const output = redact("sk-ant-api03-CANARYANTHROPIC000000000000");
    assert.equal(output, REDACTED_API_KEY);
  });

  it("keeps quoted AWS secrets from leaking the value", () => {
    const output = redact(`AWS_SECRET_ACCESS_KEY="${SECRET_CANARIES[8]}"`);
    assert.equal(output.includes(SECRET_CANARIES[8]), false);
    assert.match(output, /AWS_SECRET_ACCESS_KEY="\[REDACTED_AWS_KEY\]"/);
  });

  it("does not treat a short sk- prefix as a key", () => {
    assert.equal(redact("sk-test", { emails: false }), "sk-test");
  });

  it("redacts database URLs that carry credentials and leaves bare URLs", () => {
    const cases = [
      "postgres://app:s3cret@db.example:5432/app",
      "postgresql://app:s3cret@db.example/app",
      "mysql://app:s3cret@db.example:3306/app",
      "mongodb://app:s3cret@db.example:27017/app",
      "mongodb+srv://app:s3cret@db.example/app",
      "redis://app:s3cret@cache.example:6379",
      "rediss://app:s3cret@cache.example:6380",
      "amqp://app:s3cret@queue.example:5672",
    ];
    for (const input of cases) {
      const output = redact(input, { emails: false });
      assert.equal(output, REDACTED_DATABASE_URL, input);
      assert.equal(output.includes("s3cret"), false);
    }
    assert.equal(redact("postgres://localhost/app", { emails: false }), "postgres://localhost/app");
    assert.equal(redact("https://example.com/docs", { emails: false }), "https://example.com/docs");
  });

  it("redacts password assignments and leaves the word in prose", () => {
    assert.equal(redact("password=s3cret", { emails: false }), `password=${REDACTED_PASSWORD}`);
    assert.equal(redact("PASSWORD: s3cret", { emails: false }), `PASSWORD: ${REDACTED_PASSWORD}`);
    assert.equal(redact("passwd=s3cret", { emails: false }), `passwd=${REDACTED_PASSWORD}`);
    assert.equal(redact('pwd="s3cret"', { emails: false }), `pwd="${REDACTED_PASSWORD}"`);
    assert.equal(redact("Choose a password before you deploy.", { emails: false }), "Choose a password before you deploy.");
    assert.equal(redact("password=s3cret", { emails: false }).includes("s3cret"), false);
  });

  it("redacts prefixed, JSON, YAML, and compose password values only", () => {
    const cases: Array<[string, string]> = [
      ["DB_PASSWORD=hunter2secret", `DB_PASSWORD=${REDACTED_PASSWORD}`],
      ["POSTGRES_PASSWORD=hunter2secret", `POSTGRES_PASSWORD=${REDACTED_PASSWORD}`],
      ['MYSQL_ROOT_PASSWORD="hunter2secret"', `MYSQL_ROOT_PASSWORD="${REDACTED_PASSWORD}"`],
      ["PGPASSWORD=hunter2secret", `PGPASSWORD=${REDACTED_PASSWORD}`],
      ['{"password": "hunter2secret"}', `{"password": "${REDACTED_PASSWORD}"}`],
      ["password: hunter2secret", `password: ${REDACTED_PASSWORD}`],
      ["- POSTGRES_PASSWORD=hunter2secret", `- POSTGRES_PASSWORD=${REDACTED_PASSWORD}`],
    ];
    for (const [input, expected] of cases) {
      const output = redact(input, { emails: false });
      assert.equal(output, expected, input);
      assert.equal(output.includes("hunter2secret"), false, input);
    }
    const untouched = [
      "Enter your password",
      "Choose a password before you deploy.",
      "password reset link",
      "passwordless",
      "PASSWORD_MIN_LENGTH=8",
      "PASSWORD_MIN_LENGTH = 8",
    ];
    for (const input of untouched) {
      assert.equal(redact(input, { emails: false }), input, input);
    }
  });

  it("redacts quoted, single-quoted, flag, and structured password values", () => {
    const cases: Array<[string, string]> = [
      ['password: "s3cr#t!xyz"', `password: "${REDACTED_PASSWORD}"`],
      ['DB_PASSWORD="ab;cd;secret"', `DB_PASSWORD="${REDACTED_PASSWORD}"`],
      ['password="hunter 2 secret"', `password="${REDACTED_PASSWORD}"`],
      ["{'password': 'hunter2secret'}", `{'password': '${REDACTED_PASSWORD}'}`],
      ["{'db_password': 'hunter2secret'}", `{'db_password': '${REDACTED_PASSWORD}'}`],
      ['password = "a=b:c@d#e;f,g"', `password = "${REDACTED_PASSWORD}"`],
      ["export DB_PASSWORD=hunter2secret", `export DB_PASSWORD=${REDACTED_PASSWORD}`],
      ["--password=hunter2secret", `--password=${REDACTED_PASSWORD}`],
      ["--password hunter2secret", `--password ${REDACTED_PASSWORD}`],
      ["--db-password hunter2secret", `--db-password ${REDACTED_PASSWORD}`],
      ['fn(password="hunter2secret")', `fn(password="${REDACTED_PASSWORD}")`],
      ["PASSWORD: 'hunter2secret'", `PASSWORD: '${REDACTED_PASSWORD}'`],
      ['password: "say \\"s3cret\\""', `password: "${REDACTED_PASSWORD}"`],
      ['password: "s3cr#t!xyz\nstill-secret"', `password: "${REDACTED_PASSWORD}"`],
      [
        '- POSTGRES_PASSWORD="ab;cd;secret"',
        `- POSTGRES_PASSWORD="${REDACTED_PASSWORD}"`,
      ],
    ];
    for (const [input, expected] of cases) {
      assert.equal(redact(input, { emails: false }), expected, input);
    }
  });

  it("keeps no 3-character window of a symbol-rich password", () => {
    const printable = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)).join("");
    const dense = printable.slice(1);
    const wrapped = [
      `password: "${escapeDq(printable)}"`,
      `DB_PASSWORD="${escapeDq(printable)}"`,
      `password="${escapeDq(printable)}"`,
      `{'password': '${escapeSq(printable)}'}`,
      `{'db_password': '${escapeSq(printable)}'}`,
      `password = "${escapeDq(printable)}"`,
      `export DB_PASSWORD="${escapeDq(printable)}"`,
      `--password="${escapeDq(printable)}"`,
      `--password "${escapeDq(printable)}"`,
      `--db-password "${escapeDq(printable)}"`,
      `fn(password="${escapeDq(printable)}")`,
      `PASSWORD: '${escapeSq(printable)}'`,
      `password:\n  "${escapeDq(printable)}"\nnext: kept`,
      `export DB_PASSWORD=${dense}`,
      `--password=${dense}`,
      `--password ${dense}`,
      `--db-password ${dense}`,
      `DB_PASSWORD=${dense};`,
      `password = '${sqlSq(printable)}'`,
      `PASSWORD='${sqlSq(printable)}'`,
      `{'password': '${sqlSq(printable)}'}`,
      `password: "${sqlDq(printable)}"`,
    ];
    for (const input of wrapped) {
      const output = redact(input, { emails: false });
      assertNoPasswordWindow(output, printable, input);
      assert.equal(output.includes("next: kept") || !input.includes("next: kept"), true);
    }
  });

  it("redacts a configured domain and its subdomains only", () => {
    const options = { emails: false, domains: ["corp.example"] };
    assert.equal(redact("git.corp.example", options), REDACTED_HOST);
    assert.equal(redact("api.corp.example:8443", options), REDACTED_HOST);
    assert.equal(redact("localhost", options), "localhost");
    assert.equal(redact("example.com", options), "example.com");
    assert.equal(redact("https://example.com/docs", options), "https://example.com/docs");
  });

  it("drops an email from the comment, the timeline image, and JSON by default", () => {
    const summary = withSteps({
      source: "claude-code",
      sessionId: "synthetic-email",
      title: `Mail ${EMAIL_CANARY} about the bug.`,
      decision: `Tell ${EMAIL_CANARY} the tests passed.`,
      files: [],
      tests: [{ command: `echo ${EMAIL_CANARY}`, outcome: "pass" }],
      events: [{ kind: "test", command: `echo ${EMAIL_CANARY}`, outcome: "pass" }],
    });
    const comment = renderComment(summary);
    const svg = renderSvg(summary);
    const png = renderPng(svg);
    const json = JSON.stringify(toPublicJson(presentSummary(summary).summary));
    for (const surface of [comment, svg, png.toString("utf8"), json]) {
      assert.equal(surface.includes(EMAIL_CANARY), false);
    }
  });

  it("redacts SQL doubled quotes inside a quoted password", () => {
    const cases: Array<[string, string]> = [
      ["password = 'it''s-secret'", `password = '${REDACTED_PASSWORD}'`],
      ["PASSWORD='a''b''c'", `PASSWORD='${REDACTED_PASSWORD}'`],
      ["{'password': 'x''y'}", `{'password': '${REDACTED_PASSWORD}'}`],
      ['password: "say ""hi"" secret"', `password: "${REDACTED_PASSWORD}"`],
    ];
    for (const [input, expected] of cases) {
      assert.equal(redact(input, { emails: false }), expected, input);
    }
  });
});

function escapeDq(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeSq(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function sqlSq(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

function sqlDq(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '""');
}

function assertNoPasswordWindow(output: string, secret: string, input: string): void {
  for (let index = 0; index + 3 <= secret.length; index += 1) {
    const window = secret.slice(index, index + 3);
    assert.equal(output.includes(window), false, `${JSON.stringify(input.slice(0, 48))} leaked ${JSON.stringify(window)}`);
  }
}

function escapeReg(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REDACTED_API_KEY,
  REDACTED_AWS_KEY,
  REDACTED_EMAIL,
  REDACTED_GITHUB_TOKEN,
  REDACTED_HOST,
  REDACTED_IP,
  redact,
} from "../src/redact.js";
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
    assert.equal(output.includes(EMAIL_CANARY), true);
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
    assert.equal(output.includes(REDACTED_EMAIL), false);
  });

  it("redacts emails only when asked", () => {
    const output = redact(`ping ${EMAIL_CANARY}`, { emails: true });
    assert.equal(output.includes(EMAIL_CANARY), false);
    assert.match(output, new RegExp(escapeReg(REDACTED_EMAIL)));
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
    assert.equal(redact("sk-test"), "sk-test");
  });
});

function escapeReg(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

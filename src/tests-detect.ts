import type { TestOutcome } from "./types.js";

/**
 * Commands that mean "the agent ran the test suite".
 * Matched against a shell invocation, not against prose.
 * Leading environment assignments (`FOO=bar npm test`) are ignored.
 */
const TEST_COMMAND =
  /^(?:npm(?:\s+run)?\s+test|pnpm(?:\s+run)?\s+test|yarn\s+test|bun\s+(?:run\s+)?test|npx\s+(?:vitest|jest|mocha)|vitest|jest|mocha|pytest|py\.test|python(?:3)?\s+-m\s+pytest|tox|cargo\s+test|go\s+test|mvn(?:\s+\S+)*\s+test|gradle(?:w)?(?:\s+\S+)*\s+test|ctest|make\s+test|rake\s+test|rspec|phpunit|mix\s+test|deno\s+test|dotnet\s+test)\b/;

export function isTestCommand(command: string): boolean {
  const flat = command.replace(/\s+/g, " ").trim();
  const parts = flat.split(/\s*(?:&&|\|\||[;&|])\s*/);
  return parts.some((part) => {
    const stripped = part.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
    return TEST_COMMAND.test(stripped);
  });
}

/**
 * Node's built-in TAP reporter prints a summary even when the shell pipeline
 * exits 0 (`npm test | tee log`). Those counts decide the outcome. A successful
 * `tee` is not a passing suite.
 */
export function classifyNodeTap(output: string): TestOutcome | undefined {
  const fail = lastTapCount(output, "fail");
  const pass = lastTapCount(output, "pass");
  if (fail !== undefined && fail > 0) return "fail";
  if (pass !== undefined && pass > 0 && (fail === undefined || fail === 0)) return "pass";
  if (/\bnot ok\b/i.test(output)) return "fail";
  return undefined;
}

export function classifyTestOutput(
  output: string,
  isError: boolean,
  interrupted = false,
): TestOutcome {
  if (interrupted) return "fail";
  const tap = classifyNodeTap(output);
  if (tap) return tap;
  if (isError) return "fail";
  const failedCount = /(\d+)\s+failed\b/i.exec(output);
  if (failedCount && Number(failedCount[1]) > 0) return "fail";
  if (/\b(FAIL|FAILED|FAILURES)\b/.test(output)) return "fail";
  if (/\bexit code (?!0\b)\d+/i.test(output)) return "fail";
  if (
    /\b(PASS|PASSED)\b/.test(output) ||
    /\b\d+\s+passed\b/i.test(output) ||
    /\bexit code 0\b/i.test(output) ||
    (failedCount !== null && Number(failedCount[1]) === 0)
  ) {
    return "pass";
  }
  return "unknown";
}

function lastTapCount(output: string, label: string): number | undefined {
  const pattern = new RegExp(`^\\s*#\\s+${label}\\s+(\\d+)\\s*$`, "gim");
  let last: number | undefined;
  for (const match of output.matchAll(pattern)) {
    last = Number(match[1]);
  }
  return last;
}

/** The test invocation inside a pipeline, without tee or log paths. */
export function displayTestCommand(command: string): string {
  const flat = command.replace(/\s+/g, " ").trim();
  const parts = flat.split(/\s*(?:&&|\|\||[;&|])\s*/);
  for (const part of parts) {
    const stripped = part.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").replace(/\s+\d*>&\d+.*$/, "").trim();
    const match = stripped.match(TEST_COMMAND);
    if (match?.[0]) return match[0];
  }
  return "";
}

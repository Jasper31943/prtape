import type { SessionDraft, SessionSummary, TimelineEvent } from "./types.js";
import { withSteps } from "./summary.js";

export interface RedactOptions {
  /** Emails are removed unless this is false. */
  emails?: boolean;
  /** Extra domains, plus their subdomains, to remove. No built-in company list. */
  domains?: string[];
}

/**
 * Replacement tokens. They are stable on purpose so a second pass is a no-op
 * and tests can assert on them.
 */
export const REDACTED_API_KEY = "[REDACTED_API_KEY]";
export const REDACTED_GITHUB_TOKEN = "[REDACTED_GITHUB_TOKEN]";
export const REDACTED_AWS_KEY = "[REDACTED_AWS_KEY]";
export const REDACTED_IP = "[REDACTED_IP]";
export const REDACTED_HOST = "[REDACTED_HOST]";
export const REDACTED_EMAIL = "[REDACTED_EMAIL]";
export const REDACTED_DATABASE_URL = "[REDACTED_DATABASE_URL]";
export const REDACTED_PASSWORD = "[REDACTED_PASSWORD]";

interface Rule {
  pattern: RegExp;
  replace: string;
}

/**
 * Default redaction. Order matters: `sk-ant-` before generic `sk-`.
 *
 * Patterns are intentionally prefix-based, not entropy-based. A novel secret
 * that does not match these shapes is not caught. Emails are removed unless
 * `options.emails` is false.
 */
const SECRET_RULES: Rule[] = [
  {
    pattern: /sk-ant-[A-Za-z0-9_-]{8,}/g,
    replace: REDACTED_API_KEY,
  },
  {
    pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}/g,
    replace: REDACTED_API_KEY,
  },
  {
    pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g,
    replace: REDACTED_GITHUB_TOKEN,
  },
  {
    pattern: /(?<![A-Z0-9])(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{16}(?![A-Z0-9])/g,
    replace: REDACTED_AWS_KEY,
  },
  {
    pattern:
      /(aws_secret_access_key|AWS_SECRET_ACCESS_KEY)(\s*[=:]\s*)(["']?)[^\s"'\\]+/gi,
    replace: `$1$2$3${REDACTED_AWS_KEY}`,
  },
  {
    // RFC1918 plus link-local. Loopback is left alone.
    pattern:
      /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2})\b/g,
    replace: REDACTED_IP,
  },
  {
    // Hostnames that end in .internal or .local. `localhost` has no dot, so it stays.
    pattern:
      /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+(?:internal|local)(?![A-Za-z0-9.-])/g,
    replace: REDACTED_HOST,
  },
];

const EMAIL_RULE: Rule = {
  pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  replace: REDACTED_EMAIL,
};

export function redact(value: string, options: RedactOptions = {}): string {
  const databaseUrl =
    /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|rediss|amqp):\/\/[^\s/:@]+:[^\s/@]+@[^\s'"]+/gi;
  const passwordAssignment = /\b(password|passwd|pwd)\b(\s*[=:]\s*)(["']?)([^\s"'#;]+)\3/gi;
  let out = value.replace(databaseUrl, REDACTED_DATABASE_URL);
  out = out.replace(passwordAssignment, `$1$2${REDACTED_PASSWORD}`);
  for (const rule of SECRET_RULES) {
    out = out.replace(rule.pattern, rule.replace);
  }
  if (options.emails !== false) {
    out = out.replace(EMAIL_RULE.pattern, EMAIL_RULE.replace);
  }
  return redactDomains(out, options.domains ?? []);
}

function redactDomains(value: string, domains: string[]): string {
  let out = value;
  for (const domain of domains) {
    const trimmed = domain.trim().replace(/^\.+|\.+$/g, "");
    if (!/^[A-Za-z0-9.-]+$/.test(trimmed) || !trimmed.includes(".")) continue;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\\.)*${escaped}(?::\\d+)?(?![A-Za-z0-9.-])`,
      "gi",
    );
    out = out.replace(pattern, REDACTED_HOST);
  }
  return out;
}

function redactEvent(event: TimelineEvent, options: RedactOptions): TimelineEvent {
  if (event.kind === "read") return { kind: "read", path: event.path ? redact(event.path, options) : undefined };
  if (event.kind === "edit") return { kind: "edit", path: redact(event.path, options), action: event.action };
  if (event.kind === "test") return { ...event, command: redact(event.command, options) };
  return event;
}

function redactOptional(value: string | undefined, options: RedactOptions): string | undefined {
  if (value === undefined) return undefined;
  return redact(value, options);
}

export function redactSession(summary: SessionSummary | SessionDraft, options: RedactOptions = {}): SessionSummary {
  const draft: SessionDraft = {
    source: summary.source,
    sessionId: redact(summary.sessionId, options),
    startedAt: redactOptional(summary.startedAt, options),
    model: redactOptional(summary.model, options),
    branch: redactOptional(summary.branch, options),
    cwd: redactOptional(summary.cwd, options),
    title: redact(summary.title, options),
    decision: redact(summary.decision, options),
    files: summary.files.map((file) => ({
      path: redact(file.path, options),
      action: file.action,
    })),
    tests: summary.tests.map((test) => ({
      command: redact(test.command, options),
      outcome: test.outcome,
    })),
    events: summary.events?.map((event) => redactEvent(event, options)),
  };
  return withSteps(draft);
}

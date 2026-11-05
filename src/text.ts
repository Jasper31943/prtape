/** Collapse whitespace into a single line. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Shorten `value` to `max` characters, counting the ellipsis. */
export function truncate(value: string, max: number): string {
  const text = oneLine(value);
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** First sentence, used as the short "ask" on the visual timeline. */
export function firstSentence(value: string): string {
  const line = oneLine(value);
  const match = /^(.+?[.!?])(?:\s|$)/.exec(line);
  return match?.[1] ?? line;
}

export function escapeMdCell(value: string): string {
  return oneLine(value).replace(/\|/g, "\\|");
}

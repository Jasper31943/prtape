import { oneLine } from "../text.js";

/** Approximate rendered width. CJK and the ellipsis count as one em; bold Latin is wider than 0.5em. */
export function textWidth(value: string, fontSize: number): number {
  let width = 0;
  for (const ch of value) {
    if (ch === " ") width += fontSize * 0.33;
    else if (isWide(ch)) width += fontSize;
    else width += fontSize * 0.62;
  }
  return width;
}

/**
 * Wrap onto at most `maxLines`. Wide characters and over-long tokens break
 * so a line cannot extend past `maxWidth`. Leftover text ends with an ellipsis.
 */
export function wrapText(value: string, maxWidth: number, fontSize: number, maxLines: number): string[] {
  const source = [...oneLine(value)];
  if (source.length === 0 || maxLines < 1 || maxWidth <= 0) return [];
  const lines: string[] = [];
  let index = 0;
  while (index < source.length && lines.length < maxLines) {
    const last = lines.length === maxLines - 1;
    const line: string[] = [];
    let consumed = index;
    while (consumed < source.length) {
      const ch = source[consumed] ?? "";
      const candidate = line.join("") + ch;
      if (line.length > 0 && textWidth(candidate, fontSize) > maxWidth) break;
      line.push(ch);
      consumed += 1;
    }
    if (!last && consumed < source.length) {
      const space = line.lastIndexOf(" ");
      if (space > 0) {
        consumed -= line.length - space - 1;
        line.splice(space);
      }
    }
    let drawn = line.join("").trimEnd();
    if (last && consumed < source.length) {
      while (drawn && textWidth(`${drawn}…`, fontSize) > maxWidth) drawn = dropLast(drawn);
      drawn = `${drawn}…`;
      consumed = source.length;
    }
    if (!drawn) break;
    lines.push(drawn);
    index = consumed;
    if (source[index] === " ") index += 1;
  }
  return lines;
}

function dropLast(value: string): string {
  const chars = [...value];
  chars.pop();
  return chars.join("");
}

function isWide(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  if (ch === "…" || ch === "—" || ch === "·") return true;
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

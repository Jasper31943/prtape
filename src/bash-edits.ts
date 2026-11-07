import { isScratchPath } from "./privacy.js";
import { isTestCommand } from "./tests-detect.js";

export interface BashEdit {
  path: string;
  action: "edit" | "write";
}

export type BashEvent =
  | { kind: "read"; path?: string }
  | { kind: "edit"; path: string; action: "edit" | "write" }
  | { kind: "test" }
  | { kind: "commit" };

const READERS = new Set(["cat", "head", "tail", "less", "more", "bat", "nl"]);

/**
 * Project files a Bash command writes, conservatively.
 * Counts in-place `sed -i` / `perl -i` and unquoted `>` / `>>` into the project.
 * Does not count reads, `tee` log capture, or scratch paths.
 */
export function bashFileEdits(command: string): BashEdit[] {
  const edits: BashEdit[] = [];
  for (const event of bashEvents(command)) {
    if (event.kind === "edit") remember(edits, event.path, event.action);
  }
  return edits;
}

/**
 * Left-to-right actions inside one Bash command.
 * A test command drops setup reads (`cat package.json && npm test`) so the
 * test stays the event. Edits keep their place relative to that test
 * (`sed -i file && npm test` is an edit, then the test).
 */
export function bashEvents(command: string): BashEvent[] {
  const events: BashEvent[] = [];
  let sawTest = false;
  for (const segment of splitSegments(command)) {
    for (const event of segmentEvents(segment)) {
      if (event.kind === "test") sawTest = true;
      events.push(event);
    }
  }
  return sawTest ? events.filter((event) => event.kind !== "read") : events;
}

function segmentEvents(segment: string): BashEvent[] {
  const body = stripLead(segment);
  if (!body) return [];
  const words = shellWords(body);
  const head = words[0] ?? "";
  if (!head || head === "tee") return [];
  if (head === "git" && words[1] === "commit") return [{ kind: "commit" }];
  if (head === "sed") {
    return sedTargets(words)
      .filter((file) => !isScratchPath(file))
      .map((file) => ({ kind: "edit" as const, path: file, action: "edit" as const }));
  }
  if (head === "perl") {
    return perlTargets(words)
      .filter((file) => !isScratchPath(file))
      .map((file) => ({ kind: "edit" as const, path: file, action: "edit" as const }));
  }
  if (isTestCommand(body)) return [{ kind: "test" }];
  const writes = redirectTargets(body).filter((file) => !isScratchPath(file));
  if (writes.length > 0) {
    return writes.map((file) => ({ kind: "edit" as const, path: file, action: "write" as const }));
  }
  if (READERS.has(head)) {
    const file = readerTarget(words);
    if (file && isScratchPath(file)) return [];
    return [{ kind: "read", path: file }];
  }
  return [];
}

function readerTarget(words: string[]): string | undefined {
  const positionals: string[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "-n" || word === "-c" || word === "-b") {
      index += 1;
      continue;
    }
    if (word.startsWith("-")) continue;
    positionals.push(word);
  }
  return positionals.at(-1);
}

function remember(edits: BashEdit[], filePath: string, action: BashEdit["action"]): void {
  const cleaned = filePath.trim();
  if (!cleaned || cleaned === "&" || isScratchPath(cleaned)) return;
  if (edits.some((edit) => edit.path === cleaned)) return;
  edits.push({ path: cleaned, action });
}

function splitSegments(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index] ?? "";
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    const next = command[index + 1];
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      parts.push(current);
      current = "";
      index += 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function stripLead(segment: string): string {
  let rest = segment.trim();
  const env = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:\"[^\"]*\"|'[^']*'|\S+)\s+)+/;
  rest = rest.replace(env, "");
  const wrapped = rest.match(/^(?:sudo|command|time|nice|nohup)\s+(?:-\S+\s+)*(.*)$/);
  return (wrapped?.[1] ?? rest).trim();
}

function shellWords(input: string): string[] {
  const words: string[] = [];
  for (const match of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    words.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return words;
}

function sedTargets(words: string[]): string[] {
  let inplace = false;
  let expression = false;
  const positionals: string[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "-e" || word === "-f" || word === "--expression" || word === "--file") {
      expression = true;
      index += 1;
      continue;
    }
    if (word === "-i" || word === "--in-place" || word.startsWith("-i") || word.startsWith("--in-place")) {
      inplace = true;
      if (word === "-i" || word === "--in-place") {
        const suffix = words[index + 1];
        if (suffix === "" || (suffix !== undefined && /^\.[A-Za-z0-9._-]+$/.test(suffix))) index += 1;
      }
      continue;
    }
    if (word.startsWith("-")) continue;
    positionals.push(word);
  }
  if (!inplace) return [];
  return expression ? positionals : positionals.slice(1);
}

function perlTargets(words: string[]): string[] {
  let inplace = false;
  const files: string[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word.startsWith("-") && word.length > 1) {
      if (word === "-i" || word.startsWith("-i") || /^-[pne]*i[pne]*$/.test(word)) inplace = true;
      if (word === "-e" || word === "-E" || word === "-f" || /^-[pni]*e[pni]*$/.test(word)) index += 1;
      continue;
    }
    files.push(word);
  }
  return inplace ? files : [];
}

function redirectTargets(segment: string): string[] {
  const unquoted = segment.replace(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'/g, " ");
  const targets: string[] = [];
  for (const match of unquoted.matchAll(/(^|[^&0-9])(>>?)\s*(\S+)/g)) {
    const target = match[3] ?? "";
    if (!target || target.startsWith("&")) continue;
    targets.push(target);
  }
  return targets;
}

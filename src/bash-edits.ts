import { isScratchPath } from "./privacy.js";
import { isTestCommand } from "./tests-detect.js";
import type { TimelineEvent } from "./types.js";

export interface BashEdit {
  path: string;
  action: "edit" | "write";
}

export type BashEvent =
  | { kind: "read"; path?: string }
  | { kind: "edit"; path: string; action: "edit" | "write" }
  | { kind: "test" }
  | { kind: "commit"; message?: string };

const READERS = new Set(["cat", "head", "tail", "less", "more", "bat", "nl"]);
const SEARCHERS = new Set(["rg", "grep", "egrep", "fgrep"]);

/**
 * Project files a Bash command writes, conservatively.
 * Counts in-place `sed -i` / `perl -i` and unquoted `>` / `>>` into the project.
 * Does not count reads, `tee` log capture, or scratch paths.
 */
export interface BashSubstitution {
  file: string;
  old: string;
  next: string;
}

/** In-place `sed` replacements, in command order. Used to describe what the edit changed. */
export function bashSubstitutions(command: string): BashSubstitution[] {
  const found: BashSubstitution[] = [];
  for (const segment of splitSegments(command)) {
    const words = shellWords(stripLead(segment));
    if ((words[0] ?? "") !== "sed") continue;
    const files = sedTargets(words).filter((file) => !isScratchPath(file));
    const script = sedScript(words);
    const replacement = script ? parseReplacement(script) : undefined;
    if (!replacement) continue;
    for (const file of files) found.push({ file, old: replacement.old, next: replacement.next });
  }
  return found;
}

function sedScript(words: string[]): string | undefined {
  let expression: string | undefined;
  const positionals: string[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "-e" || word === "--expression") {
      expression = words[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (word === "-f" || word === "--file") {
      index += 1;
      continue;
    }
    if (word === "-i" || word === "--in-place" || word.startsWith("-i") || word.startsWith("--in-place")) {
      if (word === "-i" || word === "--in-place") {
        const suffix = words[index + 1];
        if (suffix === "" || (suffix !== undefined && /^\.[A-Za-z0-9._-]+$/.test(suffix))) index += 1;
      }
      continue;
    }
    if (word.startsWith("-")) continue;
    positionals.push(word);
  }
  if (expression !== undefined) return expression || undefined;
  return positionals[0];
}

function parseReplacement(script: string): { old: string; next: string } | undefined {
  if (!script.startsWith("s") || script.length < 4) return undefined;
  const delim = script[1] ?? "";
  if (!delim || delim === "\\") return undefined;
  const parts: string[] = [];
  let current = "";
  for (let index = 2; index < script.length; index += 1) {
    const ch = script[index] ?? "";
    if (ch === "\\" && script[index + 1] === delim) {
      current += delim;
      index += 1;
      continue;
    }
    if (ch === delim) {
      parts.push(current);
      current = "";
      if (parts.length === 2) break;
      continue;
    }
    current += ch;
  }
  if (parts.length < 2) return undefined;
  return { old: parts[0] ?? "", next: parts[1] ?? "" };
}

export function bashFileEdits(command: string): BashEdit[] {
  const edits: BashEdit[] = [];
  for (const event of bashEvents(command)) {
    if (event.kind === "edit") remember(edits, event.path, event.action);
  }
  return edits;
}

/**
 * Left-to-right actions inside one Bash command.
 * Reads joined with `;` or `&&` before a test stay, in order.
 * A pipe into the test (`cat x | npm test`) is setup, not its own beat.
 */
export function bashEvents(command: string): BashEvent[] {
  const parts = splitJoined(command);
  const parsed = parts.map((part) => ({ join: part.join, events: segmentEvents(part.text) }));
  const events: BashEvent[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    for (const event of parsed[index]?.events ?? []) {
      if (event.kind === "read" && pipedIntoTest(parsed, index)) continue;
      events.push(event);
    }
  }
  return events;
}

function pipedIntoTest(parsed: { join: Join; events: BashEvent[] }[], index: number): boolean {
  let cursor = index;
  while (cursor + 1 < parsed.length && parsed[cursor + 1]?.join === "|") {
    cursor += 1;
    if (parsed[cursor]?.events.some((event) => event.kind === "test")) return true;
  }
  return false;
}

function segmentEvents(segment: string): BashEvent[] {
  const body = stripLead(segment);
  if (!body) return [];
  const words = shellWords(body);
  const head = commandBase(words[0] ?? "");
  if (!head || head === "tee") return [];
  const git = gitEvents(words, head);
  if (git) return git;
  if (head === "sed") {
    const edits = sedTargets(words).filter((file) => !isScratchPath(file));
    if (edits.length > 0) {
      return edits.map((file) => ({ kind: "edit" as const, path: file, action: "edit" as const }));
    }
    return reads(sedReadFiles(words));
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
  if (SEARCHERS.has(head)) return reads(searchFiles(words));
  if (head === "ls") {
    const names = readerFiles("ls", words).filter((name) => name !== "." && name !== "..");
    return names.length > 0 ? reads(names) : [];
  }
  if (READERS.has(head)) return reads(readerFiles(head, words));
  return [];
}

function commandBase(word: string): string {
  const base = word.split("/").pop() ?? word;
  return base;
}

function gitEvents(words: string[], head: string): BashEvent[] | undefined {
  if (head !== "git") return undefined;
  const sub = words[1] ?? "";
  if (sub === "commit") return [{ kind: "commit", message: commitMessage(words) }];
  if (sub !== "diff" && sub !== "show" && sub !== "status" && sub !== "log") return undefined;
  const files: string[] = [];
  for (const word of words.slice(2)) {
    if (word === "--" || word.startsWith("-")) continue;
    const path = word.includes(":") ? word.slice(word.indexOf(":") + 1) : word;
    if (looksLikeFile(path)) files.push(path);
  }
  return files.length > 0 ? reads(files) : [{ kind: "read" }];
}

function commitMessage(words: string[]): string | undefined {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "-m" || word === "--message") {
      const message = words[index + 1]?.trim();
      return message || undefined;
    }
  }
  return undefined;
}

function reads(files: string[]): BashEvent[] {
  const kept = files.filter((file) => file && !isScratchPath(file));
  if (kept.length === 0) return [];
  return kept.map((file) => ({ kind: "read" as const, path: file }));
}

function readerFiles(head: string, words: string[]): string[] {
  const positionals: string[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    const takesValue = (head === "head" || head === "tail") && (word === "-n" || word === "-c");
    if (takesValue) {
      index += 1;
      continue;
    }
    if (word.startsWith("-")) continue;
    positionals.push(word);
  }
  return positionals;
}

function searchFiles(words: string[]): string[] {
  let flaggedPattern = false;
  const positionals: string[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "-e" || word === "--regexp" || word === "-f" || word === "-m") {
      flaggedPattern = word === "-e" || word === "--regexp" || word === "-f";
      index += 1;
      continue;
    }
    if (word.startsWith("-")) continue;
    positionals.push(word);
  }
  const files = flaggedPattern ? positionals : positionals.slice(1);
  return files.filter(looksLikeFile);
}

function sedReadFiles(words: string[]): string[] {
  let expression = false;
  const positionals: string[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "-e" || word === "--expression" || word === "-f" || word === "--file") {
      expression = true;
      index += 1;
      continue;
    }
    if (word.startsWith("-")) continue;
    positionals.push(word);
  }
  const files = expression ? positionals : positionals.slice(1);
  return files.filter(looksLikeFile);
}

function looksLikeFile(value: string): boolean {
  if (!value || value === "." || value === ".." || value.startsWith("-")) return false;
  return value.includes("/") || value.includes(".");
}

function remember(edits: BashEdit[], filePath: string, action: BashEdit["action"]): void {
  const cleaned = filePath.trim();
  if (!cleaned || cleaned === "&" || isScratchPath(cleaned)) return;
  if (edits.some((edit) => edit.path === cleaned)) return;
  edits.push({ path: cleaned, action });
}

type Join = "start" | "&&" | "||" | ";" | "|";

function splitSegments(command: string): string[] {
  return splitJoined(command).map((part) => part.text);
}

function splitJoined(command: string): { text: string; join: Join }[] {
  const parts: { text: string; join: Join }[] = [];
  let current = "";
  let join: Join = "start";
  let quote: "'" | '"' | null = null;
  const push = (next: Join) => {
    const text = current.trim();
    if (text) parts.push({ text, join });
    current = "";
    join = next;
  };
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
    if (ch === "&" && next === "&") {
      push("&&");
      index += 1;
      continue;
    }
    if (ch === "|" && next === "|") {
      push("||");
      index += 1;
      continue;
    }
    if (ch === "|") {
      push("|");
      continue;
    }
    if (ch === ";" || ch === "\n") {
      push(";");
      continue;
    }
    current += ch;
  }
  push("start");
  return parts;
}

/** Repo-relative paths printed in tool output, such as `ls` lines or `cat` file headers. */
export function pathsInText(text: string): string[] {
  const found: string[] = [];
  const pattern = /(?:^|[\s"'`(=>])((?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)(?=$|[\s"'`),:<])/g;
  for (const match of text.matchAll(pattern)) {
    const filePath = match[1] ?? "";
    if (!filePath || filePath.includes("..") || isGlob(filePath)) continue;
    const directories = filePath.split("/").slice(0, -1);
    if (directories.some((part) => part.includes("."))) continue;
    if (!found.includes(filePath)) found.push(filePath);
  }
  return found;
}

/** Expand a simple `*` / `?` read against concrete paths evidenced in the session. */
export function resolveReadGlobs(events: TimelineEvent[], extra: string[] = []): TimelineEvent[] {
  const known = [
    ...extra.filter((filePath) => filePath && !filePath.startsWith("/") && !filePath.includes("..") && !isGlob(filePath)),
    ...events.flatMap((event) =>
      (event.kind === "read" || event.kind === "edit") && event.path && !isGlob(event.path) ? [event.path] : [],
    ),
  ];
  const expanded: TimelineEvent[] = [];
  for (const event of events) {
    if (event.kind !== "read" || !event.path || !isGlob(event.path)) {
      expanded.push(event);
      continue;
    }
    const matches: string[] = [];
    for (const path of known) {
      if (!matches.includes(path) && globMatch(event.path ?? "", path)) matches.push(path);
    }
    if (matches.length === 0) {
      expanded.push(event);
      continue;
    }
    for (const path of matches) expanded.push({ ...event, path });
  }
  return expanded;
}

function isGlob(filePath: string): boolean {
  return filePath.includes("*") || filePath.includes("?");
}

function globMatch(pattern: string, filePath: string): boolean {
  let source = "^";
  for (const ch of pattern) {
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else if ("\\.^$+()[]{}|".includes(ch)) source += `\\${ch}`;
    else source += ch;
  }
  source += "$";
  return new RegExp(source).test(filePath);
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

import { isScratchPath } from "./privacy.js";

export interface BashEdit {
  path: string;
  action: "edit" | "write";
}

/**
 * Project files a Bash command writes, conservatively.
 * Counts in-place `sed -i` / `perl -i` and unquoted `>` / `>>` into the project.
 * Does not count reads, `tee` log capture, or scratch paths.
 */
export function bashFileEdits(command: string): BashEdit[] {
  const edits: BashEdit[] = [];
  for (const segment of splitSegments(command)) {
    const body = stripLead(segment);
    if (!body) continue;
    const words = shellWords(body);
    const head = words[0] ?? "";
    if (head === "tee") continue;
    if (head === "sed") {
      for (const file of sedTargets(words)) remember(edits, file, "edit");
      continue;
    }
    if (head === "perl") {
      for (const file of perlTargets(words)) remember(edits, file, "edit");
      continue;
    }
    for (const file of redirectTargets(body)) remember(edits, file, "write");
  }
  return edits;
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

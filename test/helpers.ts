import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { SECRET_CANARIES } from "./canaries.js";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function fixture(name: string): string {
  return fs.readFileSync(path.join(root, "fixtures", name), "utf8");
}

export function assertNoSecrets(rendered: string, raw: string): void {
  for (const canary of SECRET_CANARIES) {
    if (!raw.includes(canary)) continue;
    assert.equal(rendered.includes(canary), false, `secret leaked: ${canary}`);
  }
}

export function trackLabels(svg: string): string[] {
  return [...svg.matchAll(/y="118"[^>]*>(read|edit|fail|pass|commit)</g)].map((match) => match[1] ?? "");
}

export function assertMarkersAbsent(rendered: string, markers: readonly string[]): void {
  for (const marker of markers) {
    assert.equal(rendered.includes(marker), false, `marker leaked: ${marker}`);
  }
}

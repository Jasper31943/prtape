/**
 * One-glance failures: what broke, how to fix it, and the text-timeline fallback.
 * These strings are the product contract. Do not shorten them into a bare exit code.
 */

export const ORPHAN_BRANCH = "agenttape-media";

export function glanceMissingGh(): string {
  return [
    "Image not posted: gh is not installed.",
    "Fix: install GitHub CLI from https://cli.github.com, then run `gh auth login`.",
    "Fell back to the text timeline (ASCII + mermaid).",
  ].join("\n");
}

export function glanceUnauth(): string {
  return [
    "Image not posted: gh is not authenticated.",
    "Fix: run `gh auth login`.",
    "Fell back to the text timeline (ASCII + mermaid).",
  ].join("\n");
}

export function glancePushDenied(): string {
  return [
    `Image not posted: push to orphan branch ${ORPHAN_BRANCH} was denied.`,
    "Fix: give this account write access to the repo, then rerun `agenttape pr`.",
    "Fell back to the text timeline (ASCII + mermaid).",
  ].join("\n");
}

export function glancePushOther(detail: string): string {
  const line = detail.trim().split("\n").find((item) => item.trim()) ?? "git push failed.";
  return [
    `Image not posted: could not push the PNG to orphan branch ${ORPHAN_BRANCH}.`,
    line,
    "Fix: run `gh auth status`, confirm you can push to origin, then rerun `agenttape pr`.",
    "Fell back to the text timeline (ASCII + mermaid).",
  ].join("\n");
}

export function glanceNoOrigin(): string {
  return [
    "Image not posted: this repo has no origin remote.",
    "Fix: `git remote add origin <github-url>`, then rerun `agenttape pr`.",
    "Fell back to the text timeline (ASCII + mermaid).",
  ].join("\n");
}

export function glanceRaster(): string {
  return [
    "Image not posted: the timeline PNG could not be rendered.",
    "Fix: reinstall agenttape so the SVG rasterizer is available, then rerun `agenttape pr`.",
    "Fell back to the text timeline (ASCII + mermaid).",
  ].join("\n");
}

export function glanceRepoUnreadable(detail: string): string {
  const line = detail.trim().split("\n").find((item) => item.trim()) ?? "gh repo view failed.";
  return [
    "Image not posted: gh could not read this repository.",
    line,
    "Fix: run `gh repo view` from the project, then rerun `agenttape pr`.",
    "Fell back to the text timeline (ASCII + mermaid).",
  ].join("\n");
}

const PERMISSION =
  /permission denied|HTTP 401|HTTP 403|403 Forbidden|authentication failed|could not read Username|denied to|not authorized|write access|GH006|GH013|protected branch/i;

export function isPermissionFailure(text: string): boolean {
  return PERMISSION.test(text);
}

export function isMissingRef(text: string): boolean {
  return /couldn't find remote ref|remote ref does not exist|no such ref|not our ref/i.test(text);
}

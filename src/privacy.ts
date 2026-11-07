/**
 * Delete macOS and Linux home prefixes and Claude scratch paths from text a
 * reviewer might read. Spans are removed, not replaced with a token.
 */

const SCRATCH_TOKEN =
  /(?:\/private)?\/tmp\/claude-[A-Za-z0-9._-]+(?:\/[^\s"'`|;&<>]*)?|\/var\/folders\/[^\s"'`|;&<>]+/g;

const HOME_PREFIX = /\/Users\/[^\s/"'`|;&<>]+|\/home\/[^\s/"'`|;&<>]+/g;

/** Claude's project slug encodes `/Users/<name>/` as `-Users-<name>-`. */
const ENCODED_HOME = /-(?:Users|home)-[A-Za-z0-9._]+-/g;

export function stripPrivatePaths(text: string): string {
  return text
    .replace(SCRATCH_TOKEN, "")
    .replace(ENCODED_HOME, "")
    .replace(HOME_PREFIX, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/g, "")
    .replace(/^[ \t]+/g, "");
}

export function isScratchPath(filePath: string): boolean {
  const value = filePath.replace(/\\/g, "/").trim();
  if (!value || value === "/dev/null" || value === "nul") return true;
  if (/^(?:\/private)?\/tmp\//.test(value)) return true;
  if (value.startsWith("/var/folders/")) return true;
  if (/(?:^|\/)scratchpad(?:\/|$)/.test(value)) return true;
  if (/(?:^|\/)\.claude(?:\/|$)/.test(value)) return true;
  return false;
}

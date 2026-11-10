/**
 * Current names are PRTAPE_*. AGENTTAPE_* still works.
 * When the new name is set, even to an empty string, it wins.
 */
export function envValue(suffix: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const current = `PRTAPE_${suffix}`;
  if (env[current] !== undefined) return env[current];
  return env[`AGENTTAPE_${suffix}`];
}

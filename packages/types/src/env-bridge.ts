// Transitional bridge for the WardenX -> ChartWarden env-var rename. A process started with the legacy
// WARDENX_* names (an unrenamed VPS .env.production, CI secrets, a developer's .env) keeps working: each
// legacy name is copied to its CHARTWARDEN_* counterpart unless the new name is already set.
// Delete this file, its preload line in bunfig.toml and the entry-point imports once every environment
// has been renamed.
const LEGACY_PREFIX = "WARDENX_";
const CURRENT_PREFIX = "CHARTWARDEN_";

type EnvMap = Record<string, string | undefined>;

/** Copies legacy WARDENX_* values onto CHARTWARDEN_* in `env`; returns the legacy names it used (never values). */
export function bridgeLegacyEnv(env: EnvMap = process.env): readonly string[] {
  const used: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !key.startsWith(LEGACY_PREFIX)) continue;
    const current = CURRENT_PREFIX + key.slice(LEGACY_PREFIX.length);
    if (env[current] !== undefined) continue;
    env[current] = value;
    used.push(key);
  }
  return used;
}

/** Bridges `process.env` and, when anything was bridged, warns once with the legacy names so they get renamed. */
export function bridgeProcessEnv(): void {
  const used = bridgeLegacyEnv();
  if (used.length === 0) return;
  console.warn(
    `[env-bridge] ${used.length} legacy WARDENX_* variable(s) in use; rename to CHARTWARDEN_*: ${used.join(", ")}`,
  );
}

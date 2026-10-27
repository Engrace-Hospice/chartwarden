// apps/backend/src/bootstrap/platform-pool-guard.ts — gate for platform crons that fan out across tenants.
//
// A cron that enumerates active orgs reads them through the separately-pooled platform credential
// (DATABASE_PLATFORM_URL). Without it `buildActiveOrgEnumerator` rejects on every tick — loudly, by design (the M14
// packets-cron incident: an empty list would silently do nothing). A worker that can only ever fail is worse than none:
// each tick promotes to the DLQ alert sink, which logs one line per failure. So the composition root skips registering
// such crons and says why once, the same shape M35 and M4 already use.
import type { DbClient } from "@chartwarden/db";

/**
 * True when the platform pool is configured. Otherwise warns once, naming the cron, and returns false so the caller
 * skips building its workers and schedules. A type guard, so `platformDbHandle?.db` narrows inside the `if`.
 */
export function hasPlatformPool(
  platformDb: DbClient | undefined,
  label: string,
  warn: (message: string) => void,
  consequence?: string,
): platformDb is DbClient {
  if (platformDb) return true;
  warn(
    `${label} disabled: DATABASE_PLATFORM_URL (active-org fan-out) is required${consequence ? ` — ${consequence}` : ""}`,
  );
  return false;
}

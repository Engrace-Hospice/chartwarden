#!/usr/bin/env bun
/**
 * ChartWarden — one-shot copy of the legacy `wardenx:m14:idg:since-last-idg:*` keys to `chartwarden:...`, then delete
 * the legacy key. Lets Valkey release C merge before the 30-day since-last-idg TTL has run out on its own.
 * Covers ONLY the since-last-idg family (not the caseload hashes, the banner or the step-up counter).
 *
 * Only legacy keys with NO chartwarden counterpart are copied (SET NX): a key present under both prefixes was written
 * after release A and the chartwarden copy is the full, current entry. The remaining TTL is preserved (PTTL -> PX).
 * The legacy key is deleted only once the chartwarden key is known to exist. Safe to re-run. A key that errors (for
 * example WRONGTYPE) is counted and skipped; the run finishes and exits non-zero with the failure count.
 * DRY-RUN BY DEFAULT: nothing is written or deleted without --apply.
 *
 * Requirements: reads ONLY REDIS_URL; needs bun and ioredis, so run it from inside the compose network (for example in
 * the api container / a one-off container on that network), not from a laptop against production.
 *
 * Run:   REDIS_URL=redis://... bun run scripts/migrate-valkey-since-last-idg.ts            (dry run)
 *        REDIS_URL=redis://... bun run scripts/migrate-valkey-since-last-idg.ts --apply
 */
import Redis from "ioredis";

export const LEGACY_PREFIX = "wardenx:m14:idg:since-last-idg:";
export const NEW_PREFIX = "chartwarden:m14:idg:since-last-idg:";
const SCAN_COUNT = 500;

export type MigrationAction = "expired" | "already-migrated" | "copy";

/** Pure decision for one legacy key: what to do given its value, remaining TTL (PTTL) and whether the new key exists. */
export function decideMigration(input: {
  readonly value: string | null;
  readonly pttl: number;
  readonly newKeyExists: boolean;
}): MigrationAction {
  if (input.value === null || input.pttl === -2 || input.pttl === 0) return "expired";
  return input.newKeyExists ? "already-migrated" : "copy";
}

export function newKeyFor(legacyKey: string): string {
  return NEW_PREFIX + legacyKey.slice(LEGACY_PREFIX.length);
}

async function migrateKey(
  redis: Redis,
  legacyKey: string,
  apply: boolean,
): Promise<MigrationAction | "lost-race"> {
  const newKey = newKeyFor(legacyKey);
  const [value, pttl, newExists] = await Promise.all([
    redis.get(legacyKey),
    redis.pttl(legacyKey),
    redis.exists(newKey),
  ]);
  const action = decideMigration({ value, pttl, newKeyExists: newExists === 1 });
  if (action === "expired" || !apply) return action;
  if (action === "copy") {
    // pttl === -1 (no expiry) cannot occur for this family (always written EX); copy without one rather than invent a TTL.
    const ok =
      pttl > 0
        ? await redis.set(newKey, value as string, "PX", pttl, "NX")
        : await redis.set(newKey, value as string, "NX");
    // NX lost a race with a live write: that write is current, so the legacy copy is simply dropped below.
    if (ok === null) {
      if ((await redis.exists(newKey)) !== 1) throw new Error(`refusing to drop ${legacyKey}: ${newKey} does not exist`);
      await redis.del(legacyKey);
      return "lost-race";
    }
  }
  if ((await redis.exists(newKey)) !== 1) {
    throw new Error(`refusing to drop ${legacyKey}: ${newKey} does not exist`);
  }
  await redis.del(legacyKey);
  return action;
}

async function main(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.error("REDIS_URL must be set");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply") && !process.argv.includes("--dry-run");
  const redis = new Redis(url, { maxRetriesPerRequest: null });
  const tally = { copied: 0, alreadyMigrated: 0, expired: 0, lostRace: 0, failed: 0 };
  const seen = new Set<string>(); // SCAN may return a key more than once
  try {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `${LEGACY_PREFIX}*`, "COUNT", SCAN_COUNT);
      cursor = next;
      for (const legacyKey of keys) {
        if (seen.has(legacyKey)) continue;
        seen.add(legacyKey);
        try {
          const result = await migrateKey(redis, legacyKey, apply);
          if (result === "copy") tally.copied += 1;
          else if (result === "already-migrated") tally.alreadyMigrated += 1;
          else if (result === "lost-race") tally.lostRace += 1;
          else tally.expired += 1;
        } catch (error) {
          tally.failed += 1;
          console.error(`FAILED ${legacyKey}:`, error instanceof Error ? error.message : error);
        }
      }
    } while (cursor !== "0");
  } finally {
    redis.disconnect();
  }
  console.log(`${apply ? "APPLIED" : "DRY RUN (pass --apply to write)"}:`, JSON.stringify(tally));
  if (tally.failed > 0) {
    console.error(`${tally.failed} key(s) failed; re-run after fixing them.`);
    process.exit(1);
  }
}

if (import.meta.main) await main();

#!/usr/bin/env bun
/**
 * ChartWarden — one-shot copy of the legacy `wardenx:m14:idg:since-last-idg:*` keys to `chartwarden:...`, then delete
 * the legacy key. Lets Valkey release C merge before the 30-day since-last-idg TTL has run out on its own.
 *
 * Only legacy keys with NO chartwarden counterpart are copied (SET NX): a key present under both prefixes was written
 * after release A and the chartwarden copy is the full, current entry. The remaining TTL is preserved (PTTL -> PX).
 * Safe to re-run. DRY-RUN BY DEFAULT: nothing is written or deleted without --apply.
 *
 * Run:   REDIS_URL=redis://... bun run scripts/migrate-valkey-since-last-idg.ts            (dry run)
 *        REDIS_URL=redis://... bun run scripts/migrate-valkey-since-last-idg.ts --apply
 */
import Redis from "ioredis";

const LEGACY_PREFIX = "wardenx:m14:idg:since-last-idg:";
const NEW_PREFIX = "chartwarden:m14:idg:since-last-idg:";
const SCAN_COUNT = 500;

async function main(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.error("REDIS_URL must be set");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply") && !process.argv.includes("--dry-run");
  const redis = new Redis(url, { maxRetriesPerRequest: null });
  const tally = { copied: 0, alreadyMigrated: 0, expired: 0 };
  try {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `${LEGACY_PREFIX}*`, "COUNT", SCAN_COUNT);
      cursor = next;
      for (const legacyKey of keys) {
        const newKey = NEW_PREFIX + legacyKey.slice(LEGACY_PREFIX.length);
        const [value, pttl] = await Promise.all([redis.get(legacyKey), redis.pttl(legacyKey)]);
        if (value === null || pttl === -2 || pttl === 0) {
          tally.expired += 1;
          continue;
        }
        if ((await redis.exists(newKey)) === 1) {
          tally.alreadyMigrated += 1;
          if (apply) await redis.del(legacyKey);
          continue;
        }
        tally.copied += 1;
        if (!apply) continue;
        // pttl === -1 (no expiry) cannot occur for this family (always written EX); copy without one rather than invent a TTL.
        const ok =
          pttl > 0
            ? await redis.set(newKey, value, "PX", pttl, "NX")
            : await redis.set(newKey, value, "NX");
        // NX lost a race with a live write: that write is current, so the legacy copy is simply dropped below.
        if (ok === null) tally.copied -= 1;
        await redis.del(legacyKey);
      }
    } while (cursor !== "0");
  } finally {
    redis.disconnect();
  }
  console.log(`${apply ? "APPLIED" : "DRY RUN (pass --apply to write)"}:`, JSON.stringify(tally));
}

await main();

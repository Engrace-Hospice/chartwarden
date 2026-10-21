// apps/backend/src/modules/14-idg/consumers/since-last-idg-cache.ts — the §2.4/§4.5 per-patient "since
// last IDG" projection cache (Valkey, 30-day TTL) shared by every M9/M10/M11/M12 source consumer in this
// directory (F-164, #248, continuing the F-129/F-145 investigation of the m14 `handlers-unbound` group).
//
// SCOPE, decided from three independent first-party sources rather than assumed from `consumers/
// index.ts`'s own reserved consumer names: `packages/idg/src/packet/builder.ts`'s `SinceLastIdgInput`
// carries the comment "M9 subscription" / "M10 subscription" directly on the `significantAssessmentChanges`
// / `j2051Triggers` fields — decisive, since this is the pure type the M14-T05 build worker's read side
// must eventually satisfy, not spec prose. `packages/types/src/idg.ts`'s `PacketAssessmentChangeDigest` /
// `PacketHopeTriggerDigest` doc comments say the same in as many words ("M9 outbox-subscription
// projection" / "M10 outbox-subscription projection"). Those two are unambiguously this cache's job.
//
// M11's `order.discontinued` and M12's `medication_order.discontinued` are the OPPOSITE framing in the
// SAME two sources — `PacketOrderChangeDigest` / `PacketMedicationChangeDigest` are doc-commented "M11
// `OrderProvider.getOrdersSince` projection" / "M12 `MedicationOrderProvider.getMedicationsSince`
// projection", i.e. a SEAM PULL at build time, not a push. They are bound here anyway, and it is a
// DELIBERATE departure from the seam-vs-push rule this arc otherwise applies (F-129/F-145/F-160), because
// the seam pull as actually implemented cannot represent the fact these two events carry: `getOrdersSince`
// filters on `order_record.created_at >= since` only (`11-orders/seams/providers.ts`'s `getOrdersSince`),
// and `getMedicationsSince` filters on `activatedAt ?? signedAt >= since`
// (`12-dosespot/seams/providers.ts`'s `sinceAnchor`) — both anchor on a timestamp that is FIXED at order
// creation/activation and never moves. An order created BEFORE the cursor and discontinued AFTER it is
// therefore invisible to either seam call, no matter how the read side eventually joins them — the exact
// "since last IDG" fact a discontinuation-during-the-interval event exists to carry. This cache entry is
// the only place that fact can come from until the seam's own filter is widened (an M11/M12-side fix,
// reported to the coordinator, not attempted here). Cross-checked against `consumers/index.ts`'s own
// `M14_OUTBOX_SUBSCRIPTIONS` list, which independently reserves exactly these six consumer names under
// the "since last IDG projection cache" heading and none other from M9/M10/M11/M12 — corroborating,
// not contradicting.
//
// KEY SCHEME: one JSON object per patient, `wardenx:m14:idg:since-last-idg:<patientId>`, holding the four
// typed digest arrays the packet builder's `SinceLastIdgInput` already declares slots for
// (`significantAssessmentChanges`, `j2051Triggers`, `ordersChanged`, `medicationsChanged` — named here
// `orderChanges`/`medicationChanges` to avoid colliding with the builder's own post-cursor-filter field
// names once a future read side maps this cache onto that input). ONE object rather than one key per
// source kind: `consumers/index.ts`'s own comment calls this "the" projection cache (singular) and the
// §4.5 spec table repeats "Same projection cache" for every M9/M10/M11/M12 row — the read side, whenever
// it lands, wants one per-patient fetch, not four.
//
// `m9.assessment.recorded` (every assessment capture, not only a significant one) has no dedicated typed
// slot of its own — the builder's only assessment-shaped field is `significantAssessmentChanges`. Rather
// than invent an untyped fifth array nothing declares a consumer for (the exact "no builder input slot"
// gap this pass reports as blocked for `m19.triage_call.care_plan_change_indicated` two files over),
// `.recorded` entries are appended to the SAME `significantAssessmentChanges` list with
// `changeKind: "recorded"` / `"corrected"`, distinguishing them from a genuine significant-change entry's
// `changeKind` (its `ruleId`). This is a judgment call, flagged as such in the handback report — a future
// read-side author may instead want `.recorded` kept out of the discussion-flag-triggering list.
//
// IDEMPOTENCY: every entry carries `_digestId`, the OUTBOX EVENT'S OWN ROW ID (`event.id` on
// `DispatchableOutboxEvent`) — not a domain id pulled from the payload, because the payload's own natural
// id differs in shape per source (an assessment id, a discontinuation id, an order id with no separate
// discontinuation row) and `event.id` is uniformly present, uniformly unique per delivery, and stable
// across a redelivery of the SAME row. A redelivery is a true no-op (the entry is skipped, matching the
// `../../11-orders/outbox-consumers/m9-assessment-significant-change.ts` `alreadySuggested` precedent),
// never a duplicate list entry.
//
// TTL: 30 days flat, per the §4.5 table's own explicit "Valkey, 30-day TTL" note on `m9.assessment
// .recorded`'s row (the only row that states a number; every sibling row says "Same projection cache").
// Refreshed on every write (the whole object is re-SET with a fresh TTL), matching the
// `m9-assessment-significant-change.ts` precedent — comfortably inside D2's 15-day cadence floor with
// room for a skipped meeting.
import type { DbClient } from "@chartwarden/db";
import type {
  PacketAssessmentChangeDigest,
  PacketHopeTriggerDigest,
  PacketMedicationChangeDigest,
  PacketOrderChangeDigest,
} from "@chartwarden/types";
import type Redis from "ioredis";

// LEGACY(wardenx->chartwarden): remove after 30 days post release B (SINCE_LAST_IDG_TTL_SEC).
const LEGACY_KEY_PREFIX = "wardenx:m14:idg:since-last-idg";
const NEW_KEY_PREFIX = "chartwarden:m14:idg:since-last-idg";
export const SINCE_LAST_IDG_TTL_SEC = 30 * 24 * 60 * 60; // 30 days, per the §4.5 table's own note

/** A digest entry tagged with the outbox event id it was written from (the dedup identity). */
export type WithDigestId<T> = T & { readonly _digestId: string };

/** The one per-patient cache object — the four `SinceLastIdgInput`-shaped slots this cache feeds. */
export interface SinceLastIdgCacheEntry {
  significantAssessmentChanges: ReadonlyArray<WithDigestId<PacketAssessmentChangeDigest>>;
  j2051Triggers: ReadonlyArray<WithDigestId<PacketHopeTriggerDigest>>;
  orderChanges: ReadonlyArray<WithDigestId<PacketOrderChangeDigest>>;
  medicationChanges: ReadonlyArray<WithDigestId<PacketMedicationChangeDigest>>;
}

const EMPTY_ENTRY: SinceLastIdgCacheEntry = {
  significantAssessmentChanges: [],
  j2051Triggers: [],
  orderChanges: [],
  medicationChanges: [],
};

/** Release A: write BOTH keys, read `legacyKey`. Release B flips the read to `newKey` (with legacy fallback). */
export function cacheKeys(patientId: string): { legacyKey: string; newKey: string } {
  return {
    legacyKey: `${LEGACY_KEY_PREFIX}:${patientId}`,
    newKey: `${NEW_KEY_PREFIX}:${patientId}`,
  };
}

async function readEntry(redis: Redis, patientId: string): Promise<SinceLastIdgCacheEntry> {
  const raw = await redis.get(cacheKeys(patientId).legacyKey);
  if (!raw) return EMPTY_ENTRY;
  try {
    const parsed = JSON.parse(raw) as Partial<SinceLastIdgCacheEntry>;
    return {
      significantAssessmentChanges: Array.isArray(parsed.significantAssessmentChanges)
        ? parsed.significantAssessmentChanges
        : [],
      j2051Triggers: Array.isArray(parsed.j2051Triggers) ? parsed.j2051Triggers : [],
      orderChanges: Array.isArray(parsed.orderChanges) ? parsed.orderChanges : [],
      medicationChanges: Array.isArray(parsed.medicationChanges) ? parsed.medicationChanges : [],
    };
  } catch {
    return EMPTY_ENTRY;
  }
}

async function writeEntry(
  redis: Redis,
  patientId: string,
  entry: SinceLastIdgCacheEntry,
): Promise<void> {
  const { legacyKey, newKey } = cacheKeys(patientId);
  const serialised = JSON.stringify(entry);
  // New key first: a failure on the second write leaves legacy unwritten, so the redelivery (which
  // short-circuits on a legacy hit) redoes both instead of leaving the new key permanently behind.
  await redis.set(newKey, serialised, "EX", SINCE_LAST_IDG_TTL_SEC);
  await redis.set(legacyKey, serialised, "EX", SINCE_LAST_IDG_TTL_SEC);
}

/**
 * Append one digest entry into the named list slot of the patient's cache object, keyed by `digestId`
 * (the source outbox event's own id) for redelivery safety — a `digestId` already present is a true
 * no-op, never a duplicate. Read-modify-write against a single Valkey key, no distributed lock: two
 * concurrent deliveries for the SAME patient from DIFFERENT source events race on the final `SET` the
 * same way `../../11-orders/outbox-consumers/m9-assessment-significant-change.ts` already accepts for its
 * own banner key — acceptable here for the identical reason (low-traffic, non-hot-path, and a lost race
 * self-heals on the NEXT event for that patient, which every consumer in this file re-reads and re-writes
 * the whole object from).
 */
export async function appendSinceLastIdgEntry<K extends keyof SinceLastIdgCacheEntry>(
  redis: Redis,
  patientId: string,
  listKey: K,
  digestId: string,
  entry: SinceLastIdgCacheEntry[K][number],
): Promise<void> {
  const current = await readEntry(redis, patientId);
  const list = current[listKey] as ReadonlyArray<{ readonly _digestId: string }>;
  if (list.some((e) => e._digestId === digestId)) return; // redelivery — already recorded
  const updated: SinceLastIdgCacheEntry = {
    ...current,
    [listKey]: [...list, entry],
  };
  await writeEntry(redis, patientId, updated);
}

/** Read the current cache entry for a patient (exported for the future read-side build worker / tests). */
export async function readSinceLastIdgEntry(
  redis: Redis,
  patientId: string,
): Promise<SinceLastIdgCacheEntry> {
  return readEntry(redis, patientId);
}

/** §3.3 — a consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
export const CONSUMER_USER_ID = "";

/** Shared dependency shape for the two consumers (M11/M12) that need a scoped DB lookup to resolve a
 *  fact the payload does not carry (patientId, orderKind/drugLabel) before writing the cache entry. */
export interface SinceLastIdgDbDeps {
  readonly db: DbClient;
  readonly redis: Redis;
}

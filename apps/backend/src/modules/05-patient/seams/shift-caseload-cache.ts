// apps/backend/src/modules/05-patient/seams/shift-caseload-cache.ts — the M17 shift-assignment Valkey
// cache `caseload-provider.ts`'s own header has named since M5-T07 as "a forward additive source" (F-165,
// #248, continuing the F-138 investigation of the m5 `handlers-unbound` group).
//
// WHAT THIS CLOSES: `CaseloadStore`'s Phase-1 read answers "who is on this clinician's active caseload
// right now" from `patient_assignment` alone (`createDrizzleCaseloadStore`, `drizzle-stores.ts`) — a
// STANDING assignment. An aide covering a one-off visit today for a patient outside their standing
// caseload has never had a `patient_assignment` row for that patient, so every `caseload_membership` /
// `caseload_or_scope` ABAC check (M7/M8/M9/M12/M13/M14/M22/M33/M34) denied them the chart for the
// duration of a visit they were legitimately dispatched to. M17's own catalog comment on
// `m17.visit.assigned`/`.unassigned` (`events-by-m17.ts`) names the fix directly: "the §4.5 D11
// caseload-contribution payload M5's patientCaseloadProvider reads" / "the caseload-removal counterpart
// M5 reads" — a push cache, TTLed to the visit's own scheduled window, unioned additively with the
// standing Phase-1 read.
//
// KEY SCHEME: one Valkey HASH per (org, clinician USER id) — `wardenx:m5:caseload-cache:<org>:<userId>`
// — field = `visitId`, value = a small JSON `{patientId, expiresAt}`. Keyed on VISIT rather than on
// patient: `m17.visit.unassigned`'s payload carries `visitId` (not a diff of the whole set), and the same
// clinician can hold two concurrent shift-assigned visits for the SAME patient (a morning and an evening
// stop) — collapsing to one entry per patient would let unassigning one drop coverage for both. Keyed on
// the clinician's raw Better Auth USER id (not a membership id): `CaseloadStore.isAssigned` /
// `.assignedPatientIds` already take `userId` — see the doc comment on `createDrizzleCaseloadStore` in
// `./drizzle-stores.ts` — so reading at that id space needs no per-request DB round trip; the one-time
// membershipId→userId resolution happens at WRITE time in the outbox consumer (`membershipUserIdForOrg`,
// `./drizzle-stores.ts`), off M17's `assignedMembershipId`/`formerAssignedMembershipId` payload fields,
// never on this hot ABAC read path.
//
// EXPIRY IS READ-TIME FILTERED, not Valkey TTL alone: `scheduledEndedAt` differs per visit, and a Valkey
// HASH has no per-field TTL — so each entry carries its own `expiresAt` (the visit's scheduled end plus a
// fixed grace window for real-world overruns) and a read discards any entry whose `expiresAt` has passed,
// the same "stale entry, not a stale key" posture `14-idg/consumers/since-last-idg-cache.ts` uses for
// malformed JSON. This also means a visit that COMPLETES without ever firing `.unassigned` (the machine
// never emits it on completion — grepped `scheduling-route-service-db.ts`'s `emit(...,
// "m17.visit.unassigned", ...)` call sites: cancel/reassign/reschedule/cascade-remove only) self-heals on
// its own schedule rather than leaking forever. A flat whole-key TTL (refreshed on every write, the
// `since-last-idg-cache.ts` precedent) is the memory-safety NET underneath that, bounding a key even if an
// `.unassigned` delivery is somehow lost entirely.
//
// FAIL-OPEN ON A REDIS ERROR, DELIBERATELY, unlike the rest of this arc's Redis caches: those are
// write-side projections with no other reader; this is read the ABAC hot path calls on nearly every
// clinical route (`caseload_membership` / `caseload_or_scope`). Before this file, NONE of those checks
// depended on Redis at all — letting a Valkey outage propagate as a thrown error out of
// `isAssigned`/`assignedPatientIds` would turn a brief cache hiccup into every standing-assignment
// caseload check failing closed platform-wide, a strictly larger blast radius than the shift cache itself
// going dark. A read error here degrades to "no shift-cache contribution this call" (Phase-1 answer
// only) — the base `patient_assignment` store, still consulted FIRST on every call, is unaffected.
import type Redis from "ioredis";
import type { CaseloadStore } from "./caseload-provider";

// LEGACY(wardenx->chartwarden): remove after 1 day (SAFETY_TTL_SEC, 24 h) post release B.
const LEGACY_KEY_PREFIX = "wardenx:m5:caseload-cache";
const NEW_KEY_PREFIX = "chartwarden:m5:caseload-cache";
/** Whole-key safety-net TTL, refreshed on every write — bounds memory even if an `.unassigned` delivery
 *  is lost. Per-entry expiry (below) is what actually governs correctness. */
const SAFETY_TTL_SEC = 24 * 60 * 60; // 24h
/** Grace window added past a visit's own `scheduledEndedAt`, for a visit that runs long. */
const GRACE_MS = 2 * 60 * 60 * 1000; // 2h

/** Release A: write/delete BOTH hashes, read `legacyKey`. Release B flips the read to `newKey` (with legacy fallback). */
export function cacheKeys(
  organizationId: string,
  userId: string,
): { legacyKey: string; newKey: string } {
  return {
    legacyKey: `${LEGACY_KEY_PREFIX}:${organizationId}:${userId}`,
    newKey: `${NEW_KEY_PREFIX}:${organizationId}:${userId}`,
  };
}

interface ShiftEntry {
  readonly patientId: string;
  readonly expiresAt: string; // ISO instant
}

/** Write (or overwrite) one visit's shift-assignment entry. Idempotent by construction — a redelivery of
 *  the same `m17.visit.assigned` event re-writes the identical field/value pair. */
export async function writeShiftAssignment(
  redis: Redis,
  organizationId: string,
  userId: string,
  visitId: string,
  patientId: string,
  scheduledEndedAt: string,
): Promise<void> {
  const parsedEndMs = Date.parse(scheduledEndedAt);
  // A malformed timestamp fails toward a SHORT-lived entry (now + grace), never an unbounded one.
  const expiresAt = new Date(
    (Number.isFinite(parsedEndMs) ? parsedEndMs : Date.now()) + GRACE_MS,
  ).toISOString();
  const entry: ShiftEntry = { patientId, expiresAt };
  const { legacyKey, newKey } = cacheKeys(organizationId, userId);
  const serialised = JSON.stringify(entry);
  for (const key of [legacyKey, newKey]) {
    await redis.hset(key, visitId, serialised);
    await redis.expire(key, SAFETY_TTL_SEC);
  }
}

/** Remove one visit's shift-assignment entry (`m17.visit.unassigned`). A visit id absent from the hash —
 *  already expired, never written, or a redelivery — is a true no-op; Valkey's HDEL is idempotent. */
export async function removeShiftAssignment(
  redis: Redis,
  organizationId: string,
  userId: string,
  visitId: string,
): Promise<void> {
  const { legacyKey, newKey } = cacheKeys(organizationId, userId);
  await redis.hdel(legacyKey, visitId);
  await redis.hdel(newKey, visitId);
}

async function readUnexpiredEntries(
  redis: Redis,
  organizationId: string,
  userId: string,
): Promise<readonly ShiftEntry[]> {
  let raw: Record<string, string>;
  try {
    raw = await redis.hgetall(cacheKeys(organizationId, userId).legacyKey);
  } catch {
    return []; // Redis unavailable — degrade to "no shift contribution" (see file header)
  }
  const now = Date.now();
  const out: ShiftEntry[] = [];
  for (const value of Object.values(raw)) {
    try {
      const parsed = JSON.parse(value) as Partial<ShiftEntry>;
      if (typeof parsed.patientId !== "string" || typeof parsed.expiresAt !== "string") continue;
      if (Date.parse(parsed.expiresAt) <= now) continue; // expired — filtered at read time, not evicted
      out.push({ patientId: parsed.patientId, expiresAt: parsed.expiresAt });
    } catch {}
  }
  return out;
}

/** Every unexpired patient id shift-assigned to this clinician right now (exported for tests / a future
 *  direct read-side consumer; the ordinary caller is {@link createCaseloadStoreWithShiftCache}). */
export async function readShiftAssignedPatientIds(
  redis: Redis,
  organizationId: string,
  userId: string,
): Promise<readonly string[]> {
  const entries = await readUnexpiredEntries(redis, organizationId, userId);
  return [...new Set(entries.map((e) => e.patientId))];
}

/** Is this patient shift-assigned to this clinician right now? */
export async function readShiftIsAssigned(
  redis: Redis,
  organizationId: string,
  userId: string,
  patientId: string,
): Promise<boolean> {
  const entries = await readUnexpiredEntries(redis, organizationId, userId);
  return entries.some((e) => e.patientId === patientId);
}

/**
 * Additively union a base {@link CaseloadStore} (Phase-1: `patient_assignment` alone) with M17's
 * shift-assignment Valkey cache — the union point `caseload-provider.ts`'s own header names ("the union
 * point is the same method when M17 lands"). The base store is always consulted FIRST: the common case
 * (a standing caseload patient) never pays a Redis round trip, and a shift-only patient falls through to
 * the cache. See the file header for why a Redis read error degrades rather than propagates.
 */
export function createCaseloadStoreWithShiftCache(
  base: CaseloadStore,
  redis: Redis,
): CaseloadStore {
  return {
    async isAssigned(organizationId, userId, patientId) {
      if (await base.isAssigned(organizationId, userId, patientId)) return true;
      return readShiftIsAssigned(redis, organizationId, userId, patientId);
    },
    async assignedPatientIds(organizationId, userId) {
      const [basePatientIds, shiftPatientIds] = await Promise.all([
        base.assignedPatientIds(organizationId, userId),
        readShiftAssignedPatientIds(redis, organizationId, userId),
      ]);
      return [...new Set([...basePatientIds, ...shiftPatientIds])];
    },
  };
}

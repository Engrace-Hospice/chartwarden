// apps/backend/src/modules/20-field-safety/consumers/m18-gps-spoof.ts — M20-T04 (§7.7, M18 §1.2).
//
// §7.7's defensive badge, and nothing more. M18 emits `m18.evv.gps_spoof_suspected` at `warn`; M20 holds
// the fact for twelve hours and renders a caution marker beside that clinician's last-known-location on
// the supervisor board. **M18 owns the RESPONSE** (M18 §1.2 boundary) — this signal gates nothing in M20:
// it does not block a check-in, does not weight an escalation, and does not appear in any decision in this
// directory. It tells a supervisor reading "is everyone OK?" which row to read with M18's caveat applied.
//
// IT IS A CACHE, NOT A TABLE, AND THAT IS DELIBERATE. §7.7 specifies an in-memory entry with a 12-hour
// TTL, and M20 owns thirteen tables — none of them for this. Persisting a spoof suspicion would make M20 a
// second system of record for a judgement M18 already keeps, and the two would drift. The cost is that a
// process restart drops the badges: a MISSING caveat, never a missing alert, on a signal that is advisory
// by construction.
//
// THE ORG ID IS IN THE KEY. A process-local map has no RLS, so tenancy has to be structural: two
// memberships from different tenants can only collide if the org id is part of what identifies them. It is
// also what lets a single-tenant sweep exist without walking every entry.
import type { IsoInstant, MembershipId, OrgId } from "@wardenx/types";

/** §7.7 — how long a suspicion stays on the board. */
export const SAFETY_GPS_SPOOF_BADGE_TTL_HOURS = 12;

/** The §7.7 badge cache. */
export interface SafetyClinicianSignalCache {
  /** Record an `m18.evv.gps_spoof_suspected` delivery. `atIso` is the EVENT instant, not `now()`, so a
   *  late redelivery cannot extend a suspicion beyond its twelve hours from when M18 saw it. */
  recordGpsSpoofSuspected(orgId: OrgId, membershipId: MembershipId, atIso: IsoInstant): void;
  /** Is the badge live for this clinician at `nowIso`? */
  gpsSpoofSuspected(orgId: OrgId, membershipId: MembershipId, nowIso: IsoInstant): boolean;
  /** Drop every expired entry; returns how many were dropped. */
  prune(nowIso: IsoInstant): number;
  /** Live entry count (expired-but-unpruned entries included) — for the §8.8.3 gauge and the tests. */
  readonly size: number;
}

function signalKey(orgId: OrgId, membershipId: MembershipId): string {
  return `${orgId}:${membershipId}`;
}

/**
 * Build a §7.7 badge cache.
 *
 * Every write prunes: the map is otherwise unbounded in a long-lived process, and a safety module that
 * leaks memory in proportion to how much M18 distrusts its devices would fail on exactly the busy night it
 * is needed. Pruning on write rather than on a timer keeps it deterministic and testable with no clock.
 */
export function createSafetyClinicianSignalCache(): SafetyClinicianSignalCache {
  const suspectedUntil = new Map<string, number>();
  const ttlMs = SAFETY_GPS_SPOOF_BADGE_TTL_HOURS * 3_600_000;

  const prune = (nowIso: IsoInstant): number => {
    const now = Date.parse(nowIso);
    let dropped = 0;
    for (const [key, expiresAt] of suspectedUntil) {
      if (expiresAt <= now) {
        suspectedUntil.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  };

  return {
    recordGpsSpoofSuspected(orgId, membershipId, atIso) {
      prune(atIso);
      const expiresAt = Date.parse(atIso) + ttlMs;
      const key = signalKey(orgId, membershipId);
      // A redelivery of an OLDER event must not shorten a badge a newer one already extended.
      const current = suspectedUntil.get(key);
      if (current === undefined || expiresAt > current) suspectedUntil.set(key, expiresAt);
    },
    gpsSpoofSuspected(orgId, membershipId, nowIso) {
      const expiresAt = suspectedUntil.get(signalKey(orgId, membershipId));
      return expiresAt !== undefined && expiresAt > Date.parse(nowIso);
    },
    prune,
    get size() {
      return suspectedUntil.size;
    },
  };
}

/**
 * The ONE process-local badge cache the composition root shares between the §4.2 dashboard provider (which
 * READS the badge) and `m20.gps-spoof-badge` (which WRITES it).
 *
 * A singleton rather than a constructed dep because the two ends are wired in different scopes — the seam
 * registration runs inside `buildServer`, the consumer binding beside the outbox dispatcher — and a cache
 * whose reader and writer were different instances would record every suspicion and show none: working
 * code, passing tests, a badge that never appears. Process-local is the specification (§7.7), so a
 * module-level instance is the honest expression of it rather than a leak.
 */
let sharedCache: SafetyClinicianSignalCache | undefined;
export function safetyClinicianSignalCache(): SafetyClinicianSignalCache {
  sharedCache ??= createSafetyClinicianSignalCache();
  return sharedCache;
}

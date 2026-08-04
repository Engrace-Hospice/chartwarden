// apps/backend/src/modules/19-oncall/roster/shift-sync.ts — M19-T04 (§4.5 path 1, §2.2.2, D3).
//
// The Direct-model roster pull: read M17's `VisitAssignmentReader.tonightsOnCallRoster(orgId, asOfIso)` and
// reconcile it into `on_call_shift` rows. THIS is the seam bind Wave P2-2 acceptance #2 calls for — M17's
// on-call roster read stops being a Phase-1 deny-stub here.
//
// PURE PLANNER. The IO (the seam read, the existing-shift query, the writes) belongs to the §4.8
// `shift-sync.debounced` worker; this file turns "what M17 says" + "what M19 has" into a PLAN. That split is
// what lets the §9 tests exercise every reconciliation edge without a database or a live M17.
//
// ── FOUR READS THAT SHAPED THIS ────────────────────────────────────────────────────────────────────────
//
// 1. M17's ROSTER ENTRY NAMES A PERSON AND A WINDOW — NOT A ProviderEntity. `OnCallRosterEntry` is
//    `{ membershipId, discipline, fromIso, toIso }` and `tonightsOnCallRoster` is keyed on the ORG. But
//    `on_call_shift.provider_entity_id` is NOT NULL, because CoP 418.100(c)(2) is a per-CCN obligation:
//    each certified provider must be able to prove ITS patients could reach a nurse. So the sync runs per
//    ProviderEntity, and in a multi-PE org one roster entry legitimately becomes one shift row PER PE. That
//    is not duplication — one nurse covering two CCNs really is two coverage facts, and it is the shape the
//    coverage-gap watchdog (which scans per PE) has to see. `tenant_oncall_policy` is itself per (org, PE),
//    which is the corroborating signal that PE is the right grain.
//
// 2. AN UNREADABLE ROSTER IS NOT AN EMPTY ROSTER. §2.7's degraded class D-C says an M17 timeout at
//    shift-open falls back to the last committed rows. If the read result were a bare array, a failed read
//    would arrive as `[]` and the reconciler would read it as "nobody is on call tonight" and cancel every
//    scheduled shift — turning an upstream blip into a real coverage gap. `OnCallRosterRead` is therefore a
//    discriminated union: `unavailable` produces a no-op plan that says so.
//
// 3. THE SYNC NEVER REWRITES HISTORY. Only `scheduled` rows are reconciled away. An `active` shift is a
//    coverage claim that has already begun and a `completed` one is a night that happened; a roster change
//    at 23:00 does not mean the nurse was not on call at 22:00. If the roster genuinely changed mid-shift,
//    the honest sequence is `completeShift` then a new row — an operator action with an actor, not a
//    silent reconciliation.
//
// 4. AN UNMAPPABLE DISCIPLINE IS SKIPPED AND REPORTED, NEVER DEFAULTED. `OnCallRosterEntry.discipline` is
//    typed `string` on M17's side. Defaulting an unrecognised value to `clinical_rn` would manufacture RN
//    coverage the agency does not have — the exact claim a surveyor checks — so unmapped entries land in
//    `skipped` and the worker logs them. The gap then shows up as a gap, which is the truth.
import type {
  IsoInstant,
  MembershipId,
  OnCallRosterEntry,
  OnCallShiftId,
  OncallModel,
  OncallShiftDiscipline,
  ProviderEntityId,
} from "@wardenx/types";
import { TriageStateError } from "../lifecycle/errors";
import type { OnCallShiftFacts } from "./shift-machine";

// ── the M17 discipline vocabulary → `oncall_shift_discipline` ────────────────────────────────────────

/**
 * §4.5 / §3.2 — map an `OnCallRosterEntry.discipline` string onto M19's enum.
 *
 * A TABLE rather than a cast, because the two vocabularies are owned by different modules and only overlap
 * by convention. The M17-side spellings accepted here are the `oncall_shift_discipline` members themselves
 * plus the short clinical forms M17's `assignedDisciplineAtAssignment` uses (`rn` / `lpn`), which is what
 * an M17 roster row realistically carries. `external` is deliberately ABSENT: M17's roster is built from
 * agency assignments and only ever names a membership, while an `external` shift must carry
 * `external_actor_id` and NO membership per §3.3's `m19_on_call_shift_actor_integrity` CHECK. A Direct sync
 * that emitted one would produce a row PostgreSQL refuses.
 */
const ROSTER_DISCIPLINE_MAP: Readonly<Record<string, Exclude<OncallShiftDiscipline, "external">>> =
  {
    clinical_rn: "clinical_rn",
    rn: "clinical_rn",
    clinical_lpn: "clinical_lpn",
    lpn: "clinical_lpn",
    medical_director: "medical_director",
    msw: "msw",
    chaplain: "chaplain",
  };

/** §4.5 — the mapped discipline, or `null` when M17 named one M19 has no enum member for. */
export function rosterDiscipline(raw: string): Exclude<OncallShiftDiscipline, "external"> | null {
  return ROSTER_DISCIPLINE_MAP[raw.trim().toLowerCase()] ?? null;
}

/** The throwing form, for a caller that has already established the value should map (the §5 shift
 *  editor's server-side validation). The reconciler uses {@link rosterDiscipline} and reports instead. */
export function requireRosterDiscipline(raw: string): Exclude<OncallShiftDiscipline, "external"> {
  const mapped = rosterDiscipline(raw);
  if (mapped === null) {
    throw new TriageStateError(
      "ROSTER_DISCIPLINE_UNMAPPED",
      `M17 roster discipline '${raw}' maps to no oncall_shift_discipline member`,
    );
  }
  return mapped;
}

// ── the reconciler's inputs ──────────────────────────────────────────────────────────────────────────

/** §2.7 D-C — what the M17 roster read produced. See read 2 in the file header. */
export type OnCallRosterRead =
  | { readonly kind: "roster"; readonly entries: readonly OnCallRosterEntry[] }
  | { readonly kind: "unavailable"; readonly reason: string };

/** An existing `on_call_shift` row as the reconciler sees it — its identity plus the §2.2.2 facts. */
export interface ExistingOnCallShift extends OnCallShiftFacts {
  readonly shiftId: OnCallShiftId;
  readonly providerEntityId: ProviderEntityId;
}

/** Everything the §4.8 `shift-sync.debounced` worker resolves before the plan can be computed. */
export interface OnCallRosterSyncFacts {
  readonly providerEntityId: ProviderEntityId;
  /** D3 — `tenant_oncall_policy.model` for THIS provider entity. */
  readonly model: OncallModel;
  readonly rosterRead: OnCallRosterRead;
  /** Every non-terminal shift M19 already holds for this PE in the window being reconciled. */
  readonly existingShifts: readonly ExistingOnCallShift[];
  /** D7 — the policy row as it stands now, stamped onto any row the plan creates. */
  readonly policySnapshot: unknown;
}

// ── the plan ─────────────────────────────────────────────────────────────────────────────────────────

/** A `scheduled` row the plan wants inserted. Every §3.3 NOT NULL is non-null by construction — the
 *  reconciler refuses to emit a draft it could not fully anchor. */
export interface OnCallShiftDraft {
  readonly providerEntityId: ProviderEntityId;
  readonly discipline: Exclude<OncallShiftDiscipline, "external">;
  readonly primaryOnCallMembershipId: MembershipId;
  readonly shiftStartsAt: IsoInstant;
  readonly shiftEndsAt: IsoInstant;
  /** D7 — pinned again by `activateShift`; see `./shift-machine`. */
  readonly policySnapshot: unknown;
}

/** A `scheduled` row the roster no longer names. */
export interface OnCallShiftCancellation {
  readonly shiftId: OnCallShiftId;
  readonly reason: string;
}

/** A roster entry the plan could not turn into a shift, and why. Reported, never silently dropped. */
export interface SkippedRosterEntry {
  readonly membershipId: MembershipId;
  readonly discipline: string;
  readonly reason: "discipline_unmapped" | "empty_window";
}

/** What one reconciliation decided. */
export interface OnCallRosterSyncPlan {
  /** §2.7 D-C — true when the roster could not be read; every other list is then empty. */
  readonly degraded: boolean;
  readonly degradedReason: string | null;
  readonly creates: readonly OnCallShiftDraft[];
  readonly cancels: readonly OnCallShiftCancellation[];
  /** Scheduled rows the roster still names — left exactly as they are (idempotency, §2.6). */
  readonly unchanged: readonly OnCallShiftId[];
  /** Active / completed rows the sync deliberately did not touch. See read 3 in the file header. */
  readonly preserved: readonly OnCallShiftId[];
  readonly skipped: readonly SkippedRosterEntry[];
}

/** The reason token stamped on a sync-driven cancellation. A frozen token, not prose: the §5 shift screen
 *  renders it and an operator needs to tell "the Sched cancelled this" from "M17 stopped naming them". */
export const ROSTER_SYNC_CANCELLATION_REASON = "m17_roster_no_longer_names_actor" as const;

/** The identity two shifts are "the same coverage" by: person, discipline and window. */
function coverageKey(
  membershipId: MembershipId,
  discipline: OncallShiftDiscipline,
  fromIso: IsoInstant,
  toIso: IsoInstant,
): string {
  return `${membershipId}|${discipline}|${fromIso}|${toIso}`;
}

const EMPTY_PLAN = {
  creates: [] as readonly OnCallShiftDraft[],
  cancels: [] as readonly OnCallShiftCancellation[],
  unchanged: [] as readonly OnCallShiftId[],
  skipped: [] as readonly SkippedRosterEntry[],
};

/**
 * §4.5 path 1 — reconcile one ProviderEntity's `on_call_shift` rows against M17's roster.
 *
 * The order of the three early exits is the whole degraded-mode story:
 *
 *   1. `centralized` (D3): the tenant told M19 in advance that a vendor covers these nights, and §4.5 path 2
 *      creates those rows administratively. Running the Direct pull anyway would add agency-RN shifts
 *      alongside the vendor's — and M36's `on_call` channel would then page a nurse who was never on call.
 *      `hybrid` is NOT excluded: §2.3 is explicit that a hybrid tenant produces shifts down BOTH paths.
 *   2. roster `unavailable` (§2.7 D-C): no-op, flagged degraded. The last committed rows stand.
 *   3. otherwise reconcile — create what is missing, cancel the `scheduled` rows the roster dropped, and
 *      leave everything already opened alone.
 *
 * Idempotent by construction (§2.6): a second run over an unchanged roster produces an empty `creates` and
 * an empty `cancels`, because membership is decided by the coverage key rather than by a timestamp.
 */
export function reconcileOnCallRoster(facts: OnCallRosterSyncFacts): OnCallRosterSyncPlan {
  const preserved = facts.existingShifts
    .filter((s) => s.status !== "scheduled")
    .map((s) => s.shiftId);

  if (facts.model === "centralized") {
    return {
      ...EMPTY_PLAN,
      degraded: false,
      degradedReason: null,
      preserved: facts.existingShifts.map((s) => s.shiftId),
    };
  }
  if (facts.rosterRead.kind === "unavailable") {
    return {
      ...EMPTY_PLAN,
      degraded: true,
      degradedReason: facts.rosterRead.reason,
      preserved: facts.existingShifts.map((s) => s.shiftId),
    };
  }

  const skipped: SkippedRosterEntry[] = [];
  const desired = new Map<string, OnCallShiftDraft>();
  for (const entry of facts.rosterRead.entries) {
    const discipline = rosterDiscipline(entry.discipline);
    if (discipline === null) {
      skipped.push({
        membershipId: entry.membershipId,
        discipline: entry.discipline,
        reason: "discipline_unmapped",
      });
      continue;
    }
    if (entry.toIso <= entry.fromIso) {
      // §3.3's `m19_on_call_shift_range` CHECK would refuse the row. A zero-or-negative window is a
      // coverage claim of no duration — reported, because an agency whose roster produces them is
      // producing no coverage at all and needs to know.
      skipped.push({
        membershipId: entry.membershipId,
        discipline: entry.discipline,
        reason: "empty_window",
      });
      continue;
    }
    desired.set(coverageKey(entry.membershipId, discipline, entry.fromIso, entry.toIso), {
      providerEntityId: facts.providerEntityId,
      discipline,
      primaryOnCallMembershipId: entry.membershipId,
      shiftStartsAt: entry.fromIso,
      shiftEndsAt: entry.toIso,
      policySnapshot: facts.policySnapshot,
    });
  }

  const unchanged: OnCallShiftId[] = [];
  const cancels: OnCallShiftCancellation[] = [];
  for (const shift of facts.existingShifts) {
    if (shift.status !== "scheduled") continue;
    // An `external` scheduled row belongs to §4.5 path 2 (the administrative vendor binding), not to the
    // Direct pull, and M17's roster can never name it — cancelling it here would tear down the hybrid
    // tenant's vendor coverage on every sync tick.
    if (shift.discipline === "external" || shift.primaryOnCallMembershipId === null) {
      preserved.push(shift.shiftId);
      continue;
    }
    const key = coverageKey(
      shift.primaryOnCallMembershipId,
      shift.discipline,
      shift.shiftStartsAt,
      shift.shiftEndsAt,
    );
    if (desired.delete(key)) {
      unchanged.push(shift.shiftId);
    } else {
      cancels.push({ shiftId: shift.shiftId, reason: ROSTER_SYNC_CANCELLATION_REASON });
    }
  }

  return {
    degraded: false,
    degradedReason: null,
    creates: [...desired.values()],
    cancels,
    unchanged,
    preserved,
    skipped,
  };
}

// ── the §4.8 `m17.visit.assigned` debounce trigger ───────────────────────────────────────────────────

/** `m17.visit.assigned` (M17 §4.11) — the payload M17 actually emits. */
export interface M17VisitAssignedPayload {
  readonly visitId: string;
  readonly assignedMembershipId: MembershipId;
  readonly patientId: string;
  readonly scheduledStartedAt: IsoInstant;
  readonly scheduledEndedAt: IsoInstant;
}

/** What a `m17.visit.assigned` delivery asks the shift-sync queue to do. */
export interface RosterSyncTrigger {
  /** BullMQ's debounce/dedupe token — §4.8's "debounced 30 s". */
  readonly debounceKey: string;
  readonly asOfIso: IsoInstant;
}

/**
 * §4.5 / §4.8 — turn an `m17.visit.assigned` delivery into a debounced roster-sync request.
 *
 * NO PURPOSE FILTER, and that is a spec correction rather than a shortcut. §4.5 says to sync "on every
 * `m17.visit.assigned` outbox event affecting an `on_call_*` visit purpose" — but M17's `VisitPurpose` enum
 * (packages/types/src/scheduling.ts §2.3) has no `on_call_*` member at all: it is `routine_visit | prn |
 * aide_poc | msw_* | chaplain_* | volunteer_visit | f2f | recert | loc_change | pronouncement |
 * admission_visit | discharge_visit`. Nor does the event payload carry the purpose, so even a filter
 * against a purpose that existed would need a read-back per assignment. Filtering on a value that cannot
 * occur would silently disable the sync entirely — the failure mode is a roster that never updates and a
 * green build. The debounce is what makes the unfiltered form cheap: a scheduling burst of fifty
 * assignments collapses to ONE reconciliation per org, which then re-reads the authoritative roster.
 *
 * The key is the ORG, not the visit or the membership: the reconciliation reads the whole roster anyway, so
 * two assignments 200 ms apart must not produce two identical passes.
 */
export function decideRosterSyncTrigger(
  organizationId: string,
  payload: M17VisitAssignedPayload,
  at: IsoInstant,
): RosterSyncTrigger {
  void payload;
  return { debounceKey: `m19.shift-sync:${organizationId}`, asOfIso: at };
}

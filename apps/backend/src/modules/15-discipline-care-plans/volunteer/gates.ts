// apps/backend/src/modules/15-discipline-care-plans/volunteer/gates.ts — M15-T04 (§2.2.6 / §7.5).
//
// The `volunteer_compliance_gate` lifecycle — the 42 CFR §418.78(b)/(d) credential postures the
// scheduler's pre-book decision is made from:
//
//   • `deriveGateStatus` is the SINGLE definition of what a stored gate row's status should be as of an
//     instant. The column is materialized (M17 reads it through the seam without recomputing), but the
//     column is never the authority — a row that says `satisfied` with a `valid_until` two days in the
//     past is a stale nightly run, and every read path derives over the stored value so a missed cron
//     cannot quietly re-qualify an expired volunteer.
//   • `decideRecordGate` is the §4.2 create/renew guard set: `GATE_ALREADY_CURRENT` (a current row must
//     be revoked or expired first), `VALID_UNTIL_BEFORE_VALID_FROM`, `INITIAL_TRAINING_LIFETIME`.
//   • `decideRevokeGate` / `decideExpireGate` are the two terminal paths — the coordinator's documented
//     revocation and the nightly watcher's expiry flip, which is what drives §7.5's assignment
//     inactivation cascade in `./assignments`.
//   • `planGateExpiryAlerts` is the 30/14/7/1-day ladder the watcher turns into M36 alerts, emitted at
//     most once per ladder mark per gate so a daily cron does not re-page the coordinator every morning.
//
// PURE & deterministic — `now` is injected, gate rows arrive as plain facts, nothing reads the DB.
// FAIL-CLOSED per §8.7: an unparseable or absent validity window is treated as NOT satisfied.
import {
  LIFETIME_VOLUNTEER_GATE_KINDS,
  VOLUNTEER_GATE_EXPIRY_POLICY,
  volunteerGateAlertSeverity,
} from "@wardenx/discipline-plans";
import type {
  IsoInstant,
  MembershipId,
  VolunteerComplianceGateId,
  VolunteerGateKind,
  VolunteerGateStatus,
} from "@wardenx/types";
import type { DisciplinePlanSideEffect } from "../lifecycle/effects";
import { require_ } from "../lifecycle/errors";

const MS_PER_DAY = 86_400_000;

/** The stored `volunteer_compliance_gate` columns every derivation here decides over (§2.2.6). */
export interface VolunteerGateFacts {
  readonly gateId: VolunteerComplianceGateId;
  readonly volunteerMembershipId: MembershipId;
  readonly gateKind: VolunteerGateKind;
  /** The materialized column. Advisory: `deriveGateStatus` re-derives it over the validity window. */
  readonly status: VolunteerGateStatus;
  readonly validFrom: IsoInstant;
  /** Null = non-expiring (a lifetime credential, e.g. the 418.78(b) initial orientation). */
  readonly validUntil: IsoInstant | null;
  readonly revokedAt: IsoInstant | null;
}

/** Whole days from `now` until `validUntil` (negative once elapsed); null for a non-expiring gate. */
export function daysUntilExpiry(validUntil: IsoInstant | null, now: IsoInstant): number | null {
  if (validUntil === null) return null;
  return Math.floor((Date.parse(validUntil) - Date.parse(now)) / MS_PER_DAY);
}

/**
 * §2.2.6 — the status a gate row ACTUALLY holds as of `now`, derived over its validity window rather than
 * trusted from the materialized column. Revocation wins over everything (it is a deliberate act, not a
 * clock); a window that has not opened yet is `not_yet_satisfied`; an elapsed `valid_until` is `expired`
 * whether or not last night's watcher ran; the 30-day lead-in is `expiring_soon`, which alerts but never
 * blocks (§2.2.6).
 */
export function deriveGateStatus(gate: VolunteerGateFacts, now: IsoInstant): VolunteerGateStatus {
  if (gate.revokedAt !== null) return "revoked";
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs) || Number.isNaN(Date.parse(gate.validFrom))) return "not_yet_satisfied";
  if (nowMs < Date.parse(gate.validFrom)) return "not_yet_satisfied";
  const daysOut = daysUntilExpiry(gate.validUntil, now);
  if (daysOut === null) return "satisfied";
  if (daysOut < 0) return "expired";
  return daysOut <= VOLUNTEER_GATE_EXPIRY_POLICY.expiringSoonAtDaysOut
    ? "expiring_soon"
    : "satisfied";
}

/**
 * §2.3 / §7.4 — whether a gate currently clears the scheduling precondition. `expiring_soon` clears (it is
 * a warning, not a block, §2.2.6); everything else does not. This is the one predicate
 * `../volunteer/effective-status` composes over the blocking gate set.
 */
export function isGateClearing(gate: VolunteerGateFacts, now: IsoInstant): boolean {
  const status = deriveGateStatus(gate, now);
  return status === "satisfied" || status === "expiring_soon";
}

/** What a `volunteer_compliance_gate` INSERT (create or post-expiry renewal) is decided over (§4.2). */
export interface RecordGateFacts {
  readonly volunteerMembershipId: MembershipId;
  readonly gateKind: VolunteerGateKind;
  readonly validFrom: IsoInstant;
  readonly validUntil: IsoInstant | null;
  /**
   * The existing rows for this (volunteer × gate kind). The partial unique index is the structural
   * backstop; this guard turns the would-be 23505 into the §4.2 `GATE_ALREADY_CURRENT` (409) the UI keys
   * its "revoke the current credential first" message off.
   */
  readonly existingGates: ReadonlyArray<VolunteerGateFacts>;
}

/** The decision a gate INSERT produces (§2.2.6). */
export interface RecordGateDecision {
  readonly status: VolunteerGateStatus;
  readonly effects: ReadonlyArray<DisciplinePlanSideEffect>;
}

/**
 * §4.2 — validate and decide a `volunteer_compliance_gate` INSERT. A renewal recorded while the previous
 * window is still current is refused rather than silently stacked: two live rows for one credential is
 * exactly the ambiguity a surveyor reads as an unverifiable record.
 *
 * §7.5: a renewal recorded AFTER expiry is legal and flips the volunteer's effective status back to
 * active — but previously-inactivated assignments are NOT auto-reactivated (see `./assignments`).
 */
export function decideRecordGate(facts: RecordGateFacts, now: IsoInstant): RecordGateDecision {
  if (facts.validUntil !== null) {
    require_(
      Date.parse(facts.validUntil) > Date.parse(facts.validFrom),
      "VALID_UNTIL_BEFORE_VALID_FROM",
      "a compliance gate's valid_until must fall after its valid_from",
    );
    require_(
      !LIFETIME_VOLUNTEER_GATE_KINDS.includes(facts.gateKind),
      "INITIAL_TRAINING_LIFETIME",
      `${facts.gateKind} is a one-time credential and must be recorded without a valid_until`,
    );
  }
  const current = facts.existingGates.filter(
    (g) => g.gateKind === facts.gateKind && isGateClearing(g, now),
  );
  require_(
    current.length === 0,
    "GATE_ALREADY_CURRENT",
    `a current ${facts.gateKind} gate already exists for this volunteer; revoke it before recording a new one`,
  );

  const status = deriveGateStatus(
    {
      gateId: "",
      volunteerMembershipId: facts.volunteerMembershipId,
      gateKind: facts.gateKind,
      status: "not_yet_satisfied",
      validFrom: facts.validFrom,
      validUntil: facts.validUntil,
      revokedAt: null,
    },
    now,
  );
  return { status, effects: [{ kind: "audit" }] };
}

/**
 * §4.2 / §8.1 — the coordinator's documented revocation (route 22). The reason is mandatory (the DB CHECK
 * is the backstop) and is audit-denylisted, so the audit row records that a revocation happened without
 * copying the free text.
 */
export function decideRevokeGate(
  gate: VolunteerGateFacts,
  revokedReason: string | null,
  now: IsoInstant,
): RecordGateDecision {
  const status = deriveGateStatus(gate, now);
  require_(
    status !== "revoked",
    "GATE_ALREADY_TERMINAL",
    "this compliance gate is already revoked",
  );
  require_(
    (revokedReason ?? "").trim().length > 0,
    "GATE_REVOKE_REASON_REQUIRED",
    "a revocation reason is required",
  );
  return { status: "revoked", effects: [{ kind: "audit" }] };
}

/**
 * §7.5 — the nightly watcher's expiry flip. Emits `m15.volunteer.gate_expired` (§2.4); the assignment
 * cascade the payload's `openAssignmentsCount` describes is decided in `./assignments`, so the two stay
 * independently testable and the worker composes them inside one transaction.
 */
export function decideExpireGate(gate: VolunteerGateFacts, now: IsoInstant): RecordGateDecision {
  const status = deriveGateStatus(gate, now);
  require_(
    status === "expired",
    "GATE_ALREADY_TERMINAL",
    "only a gate whose validity window has elapsed may be flipped to expired",
  );
  return {
    status: "expired",
    effects: [{ kind: "audit" }, { kind: "outbox", event: "m15.volunteer.gate_expired" }],
  };
}

/** One ladder mark the watcher fires on (§4.7 — M36 builds the alert from it in M15-T06). */
export interface VolunteerGateExpiryNotice {
  readonly gateId: VolunteerComplianceGateId;
  readonly volunteerMembershipId: MembershipId;
  readonly gateKind: VolunteerGateKind;
  readonly validUntil: IsoInstant;
  /** The ladder mark that fired — one of `VOLUNTEER_GATE_EXPIRY_POLICY.alertAtDaysOut`. */
  readonly daysOut: number;
  readonly severity: "info" | "warn" | "critical";
}

/**
 * §7.5 — the 30/14/7/1-day ladder for one nightly run. A gate fires the mark it has JUST reached (its
 * exact `daysOut`), and `alreadyNotifiedDaysOut` carries the marks already sent for that gate, so a daily
 * cron notifies once per mark instead of re-paging the coordinator every morning for 30 days. A gate that
 * is already expired produces nothing here — `decideExpireGate` owns that path.
 */
export function planGateExpiryAlerts(
  gates: ReadonlyArray<VolunteerGateFacts>,
  now: IsoInstant,
  alreadyNotifiedDaysOut: ReadonlyMap<VolunteerComplianceGateId, ReadonlyArray<number>> = new Map(),
): ReadonlyArray<VolunteerGateExpiryNotice> {
  const notices: VolunteerGateExpiryNotice[] = [];
  for (const gate of gates) {
    if (gate.validUntil === null || gate.revokedAt !== null) continue;
    const daysOut = daysUntilExpiry(gate.validUntil, now);
    if (daysOut === null || daysOut < 0) continue;
    const mark = VOLUNTEER_GATE_EXPIRY_POLICY.alertAtDaysOut.find((m) => m === daysOut);
    if (mark === undefined) continue;
    if ((alreadyNotifiedDaysOut.get(gate.gateId) ?? []).includes(mark)) continue;
    notices.push({
      gateId: gate.gateId,
      volunteerMembershipId: gate.volunteerMembershipId,
      gateKind: gate.gateKind,
      validUntil: gate.validUntil,
      daysOut: mark,
      severity: volunteerGateAlertSeverity(mark),
    });
  }
  return notices;
}

/** §7.5 — the gates a nightly run must flip to `expired` (their window elapsed since the last run). */
export function gatesToExpire(
  gates: ReadonlyArray<VolunteerGateFacts>,
  now: IsoInstant,
): ReadonlyArray<VolunteerGateFacts> {
  return gates.filter((g) => g.revokedAt === null && deriveGateStatus(g, now) === "expired");
}

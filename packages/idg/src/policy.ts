// @wardenx/idg — §1.1 / §2.2 / §2.5 pure-data policy constants (M14-T01 domain layout).
//
// The single source of the platform-floor IDG rules the lifecycle (§2.2), the quorum evaluator (D3), the
// schedule worker (D2), and the packet builder's discipline-view derivation (D7) read instead of re-deriving
// inline: the CoP 418.56(b)(3) required-quorum composition, the location-cadence backstop (with the 15-day
// platform-floor max gap and tenant-tighten-to-7 floor), and the discipline → highlight-block mapping.
//
// PURE DATA — no IO, `@wardenx/types`-only. The XState meeting machine, the quorum evaluator, the schedule
// worker, and the packet builder that consume these constants live in `apps/backend/src/modules/14-idg`
// (lifecycle in M14-T03, packet builder in M14-T04). Authority note (M14-F01 / ADR-0018 D2): the
// location-cadence policy below is an OPERATIONAL BACKSTOP only — the citation-relevant control is the
// per-patient (per-POC) 15-day review floor stamped on adjournment, enforced by `perPatientReviewFloorClear`.

import type { DisciplineKey } from "@wardenx/types";

/** One required quorum slot. `role` is a single discipline or an `a|b` either-of expression; `count` is the
 * minimum number of distinct present attendees satisfying it. */
export interface IdgQuorumSlot {
  readonly role: string;
  readonly count: number;
}

/** §1.1 / D3 — the CoP 418.56(b)(3) `IDG_REQUIRED_QUORUM`: a hospice physician/medical director, an RN, an
 * MSW, and a chaplain/spiritual counselor. Per M07-F01 the IDG physician seat is MD/DO only (an NP may NOT
 * occupy it). Platform-floor; tenants in stricter states may TIGHTEN (add disciplines), never loosen. The
 * meeting may be HELD without quorum, but `quorate_decision` (§4.7) gates per-decision recording. */
export const IDG_REQUIRED_QUORUM: readonly IdgQuorumSlot[] = [
  { role: "rn_case_manager", count: 1 },
  { role: "msw", count: 1 },
  { role: "chaplain", count: 1 },
  { role: "hospice_physician|medical_director", count: 1 },
] as const;

/** §2.2 D2 — the location-cadence backstop. `defaultCadenceDays` biweekly; `platformFloorMaxGapDays` is the
 * 15-day max gap a recurring policy may not exceed (`CADENCE_FLOOR_VIOLATION` on attempt); `tenantMayTightenTo`
 * is the tightest cadence a tenant may configure (weekly). Operational backstop only — NOT the §418.56(d)
 * control (that is the per-patient review floor; M14-F01 / ADR-0018 D2). */
export const IDG_SCHEDULE_POLICY = {
  defaultCadenceDays: 14,
  platformFloorMaxGapDays: 15,
  tenantMayTightenTo: 7,
} as const;

/** §2.3 D9 — the platform-floor post-discharge wrap-up window (days). Tenants may TIGHTEN; the 7-day floor
 * cannot be loosened (survey citation risk on missed post-discharge bereavement-risk flagging). */
export const POST_DISCHARGE_WRAP_UP_FLOOR_DAYS = 7 as const;

/** §2.2 / D13 — the freshness window (minutes) a step-up auth must fall within to ADJOURN a live meeting. */
export const ADJOURN_STEP_UP_FRESHNESS_MINUTES = 5 as const;

/** §4.4 / D4 — the canonical `idg.decision_recorded` payload schema version. Consumers refusing an unknown
 * version dead-letter + emit `m14.decision_payload_quarantined`. */
export const IDG_DECISION_PAYLOAD_SCHEMA_VERSION = "2026-01-v1" as const;

/** Which packet highlight `sourceKind`s a discipline view emphasises. Content is identical across views;
 * the meeting surface filters which blocks render by attendee role (§2.5 D7). */
export type DisciplineViewEmphasis = ReadonlyArray<
  "encounter" | "assessment" | "order" | "medication" | "hope" | "action_item" | "flag"
>;

/** §2.5 D7 — the typed `DISCIPLINE_VIEW_POLICY`: per-discipline emphasis mapping. RN → symptom/medication
 * picture; MSW → psychosocial/family (action items + flags); chaplain → spiritual/anticipatory grief; aide →
 * ADL/safety (encounters + flags); MD/NP + medical_director → prognosis/recert/complex symptoms; volunteer →
 * task/visit context. */
export const DISCIPLINE_VIEW_POLICY: { readonly [K in DisciplineKey]: DisciplineViewEmphasis } = {
  rn: ["encounter", "assessment", "order", "medication", "flag"],
  msw: ["encounter", "action_item", "flag"],
  chaplain: ["encounter", "assessment", "flag"],
  aide: ["encounter", "flag"],
  md_np: ["encounter", "assessment", "order", "medication", "hope", "flag"],
  medical_director: ["encounter", "assessment", "order", "medication", "hope", "flag"],
  volunteer: ["encounter", "action_item"],
} as const;

/** M14 spec extension — the bounded window (days after adjournment) in which a per-discipline note may still be
 * added as a LATE ADDENDUM. The adjourned minutes + their discipline-note snapshot stay frozen (D10); an addendum
 * is a separate append-only row. Beyond the window the write is refused (`ADDENDUM_WINDOW_CLOSED`) so late edits
 * cannot undermine survey reconstruction. Inclusive of the boundary instant. */
export const DISCIPLINE_NOTE_ADDENDUM_WINDOW_DAYS = 14 as const;
/** Max length of a note's `reason` (optional on live notes, REQUIRED on late addenda; free text, denylisted in the audit trigger).
 * WINDOW B: beyond the {@link DISCIPLINE_NOTE_ADDENDUM_WINDOW_DAYS} time window, a PATIENT-scoped addendum is also refused
 * (`ADDENDUM_SUPERSEDED_BY_NEWER_IDG`) once a later ADJOURNED IDG meeting has included that patient. */
export const DISCIPLINE_NOTE_ADDENDUM_REASON_MAX = 500 as const;

// ── attendance trust (M14 spec extension) ─────────────────────────────────────────────────────────────────────
//
// `idg_attendance.discipline` used to be free text a caller typed. Quorum (`IDG_REQUIRED_QUORUM`) and the per-
// discipline note authorization both TRUST that string, so it is now a CLOSED vocabulary the server validates
// against the person's AUTHORITATIVE role keys (M3 `membership_role` → `role.key`, the same source
// `request.context.roles` and M17's `resolveDisciplinesTx` derive from). PURE DATA — no IO.

/** The closed vocabulary an attendance row's `discipline` may take. The first four quorum seats are the strings
 * `IDG_REQUIRED_QUORUM` matches on; `administrator` is the non-clinical seat that NEVER counts toward quorum. */
export const IDG_ATTENDANCE_DISCIPLINES = [
  "rn_case_manager",
  "hospice_physician",
  "medical_director",
  "msw",
  "chaplain",
  "np",
  "lpn",
  "hospice_aide",
  "volunteer",
  "volunteer_coordinator",
  "bereavement_coordinator",
  "administrator",
] as const;
export type IdgAttendanceDiscipline = (typeof IDG_ATTENDANCE_DISCIPLINES)[number];

/** The `discipline` an attendee with no clinical seat (admins, supervisors) is recorded under. Not a quorum seat. */
export const IDG_ADMINISTRATIVE_DISCIPLINE: IdgAttendanceDiscipline = "administrator";

/** M3 role key → the attendance discipline(s) holding that role lets a person attest. Role keys absent here
 * (e.g. `clinician`, `auditor`, `platform_*`) confer NO attendable discipline. An `rn` (staff RN) and an
 * `rn_case_manager` both fill the RN quorum seat; `md`/`hospice_physician` fill the physician seat. */
export const IDG_ATTENDANCE_DISCIPLINES_BY_ROLE_KEY: Readonly<
  Record<string, readonly IdgAttendanceDiscipline[]>
> = {
  rn_case_manager: ["rn_case_manager"],
  rn: ["rn_case_manager"],
  hospice_physician: ["hospice_physician"],
  md: ["hospice_physician"],
  medical_director: ["medical_director"],
  msw: ["msw"],
  chaplain: ["chaplain"],
  np: ["np"],
  lpn: ["lpn"],
  chha: ["hospice_aide"],
  aide: ["hospice_aide"],
  hospice_aide: ["hospice_aide"],
  volunteer: ["volunteer"],
  volunteer_coordinator: ["volunteer_coordinator"],
  bereavement_coordinator: ["bereavement_coordinator"],
  administrator: ["administrator"],
  org_admin: ["administrator"],
  director_of_nursing: ["administrator"],
  clinical_supervisor: ["administrator"],
  compliance_officer: ["administrator"],
} as const;

/** Whether `value` is in the closed attendance-discipline vocabulary. */
export function isIdgAttendanceDiscipline(value: string): value is IdgAttendanceDiscipline {
  return (IDG_ATTENDANCE_DISCIPLINES as readonly string[]).includes(value);
}

/** The attendance disciplines a set of M3 role keys entitles its holder to attest (deduplicated, vocabulary order). */
export function attendableDisciplinesForRoleKeys(
  roleKeys: readonly string[],
): IdgAttendanceDiscipline[] {
  const held = new Set<IdgAttendanceDiscipline>();
  for (const key of roleKeys) {
    for (const d of IDG_ATTENDANCE_DISCIPLINES_BY_ROLE_KEY[key] ?? []) held.add(d);
  }
  return IDG_ATTENDANCE_DISCIPLINES.filter((d) => held.has(d));
}

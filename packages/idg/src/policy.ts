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

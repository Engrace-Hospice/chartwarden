// @wardenx/idg — D10 IDG minutes finalization + §164.526 amendment workflow (M14-T03). Pure.
//
// `idg_minutes` is the single per-meeting summary record (§1.1). It is append-only annotation-only while
// `in_progress`; on adjournment it flips to `final` and the row is immutable (the §3.4 DB CHECK + audit
// trigger refuses UPDATE of `final` content fields — M14-T02 / mirrors M7 D6). Corrections after `final`
// never edit the row: they require an `idg_minutes_amendment` row with a reason (D10, the M5 §164.526
// amendment pattern, W-MIN-01) — request (approver null) → Compliance approval → `m14.minutes.amended`.
import type { IdgMinutesStatus } from "@wardenx/types";
import type { IdgSideEffect } from "./effects";
import { require_ } from "./errors";

/**
 * Guard an in-place mutation of the minutes (an append-only annotation while `in_progress`). Throws
 * `MINUTES_FINAL` once the minutes are `final` — corrections then require the amendment workflow.
 */
export function assertMinutesMutable(status: IdgMinutesStatus): asserts status is "in_progress" {
  require_(status === "in_progress", "MINUTES_FINAL", "final minutes are immutable; use the amendment workflow");
}

/**
 * Finalize the minutes at adjournment (D10): `in_progress → final`. Driven by the meeting `ADJOURN`
 * `finalize_minutes` effect. Throws `MINUTES_NOT_IN_PROGRESS` if the minutes are not `in_progress` (a
 * second finalize is a no-op the service must not re-emit `m14.minutes.signed` for). Returns the
 * side-effect list: stamp `finalized_at`, audit, and emit `m14.minutes.signed` (M22 render trigger, §4.4).
 */
export function planMinutesFinalize(from: IdgMinutesStatus): { readonly to: "final"; readonly effects: ReadonlyArray<IdgSideEffect> } {
  require_(from === "in_progress", "MINUTES_NOT_IN_PROGRESS", "only in-progress minutes may be finalized");
  return {
    to: "final",
    effects: [
      { kind: "set_timestamp", field: "finalized_at" },
      { kind: "audit" },
      { kind: "outbox", event: "m14.minutes.signed" },
    ],
  };
}

/**
 * Request a minutes amendment (D10 / W-MIN-01): insert an `idg_minutes_amendment` row with
 * `approved_by_membership_id = null` against `final` minutes, and surface a Compliance notification via
 * M36. Throws `MINUTES_NOT_IN_PROGRESS`-inverse — an amendment only applies to `final` minutes (a
 * `MINUTES_FINAL` guard would be backwards here, so we assert the minutes ARE final). The original
 * `idg_minutes` row is never touched.
 */
export function planMinutesAmendmentRequest(minutesStatus: IdgMinutesStatus): ReadonlyArray<IdgSideEffect> {
  require_(minutesStatus === "final", "MINUTES_NOT_IN_PROGRESS", "amendments apply only to final minutes");
  return [{ kind: "audit" }, { kind: "notify_compliance" }];
}

/**
 * Approve a pending minutes amendment (D10 / W-MIN-01, the separate Compliance route): set the approver +
 * `approved_at`, and emit `m14.minutes.amended` (M22 re-render + M28 + M33, §4.4). Throws
 * `AMENDMENT_ALREADY_APPROVED` if the row already carries an approval. The original `idg_minutes` row
 * stays unchanged (the trigger refuses content-field UPDATE); the amendment row carries the correction.
 */
export function planMinutesAmendmentApproval(amendment: { readonly approvedAt: string | null }): ReadonlyArray<IdgSideEffect> {
  require_(amendment.approvedAt === null, "AMENDMENT_ALREADY_APPROVED", "this amendment has already been approved");
  return [
    { kind: "set_timestamp", field: "approved_at" },
    { kind: "audit" },
    { kind: "outbox", event: "m14.minutes.amended" },
  ];
}

// @chartwarden/quality — §2.2 QAPI governance-minutes signing + amendment logic (M30-P2a). Pure, IO-free.
//
// `qapi_governance_minutes` has a two-state lifecycle: `draft → signed`. Signed minutes are append-only;
// corrections are recorded through an M5 §164.526-pattern amendment workflow (M30's adaptation of the
// M14 D10 minutes-immutability rule) — the original `minutes_text` is never mutated, an entry is
// appended to the `amendment_log` jsonb array instead. This module is the pure core for both the sign
// transition and the append-only amendment; the route persists + audits around it.

/** The §2.2 minutes lifecycle state. */
export type MinutesState = "draft" | "signed";

/** §2.2 — an amendment reason must be at least this many characters (§164.526-pattern justification). */
const QAPI_MINUTES_AMENDMENT_REASON_MIN_CHARS = 20;

/** A pending amendment to signed minutes (the caller-supplied entry, validated before it is appended). */
export interface MinutesAmendmentInput {
  /** ISO-8601 timestamp the amendment was recorded. */
  readonly at: string;
  /** The M2 membership id of the author recording the amendment. */
  readonly byMembershipId: string;
  /** The §164.526-pattern justification (≥ {@link QAPI_MINUTES_AMENDMENT_REASON_MIN_CHARS} chars). */
  readonly reason: string;
}

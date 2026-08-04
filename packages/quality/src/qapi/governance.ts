import type { schema } from "@wardenx/db";
// @wardenx/quality — §2.2 QAPI governance-minutes signing + amendment logic (M30-P2a). Pure, IO-free.
//
// `qapi_governance_minutes` has a two-state lifecycle: `draft → signed`. Signed minutes are append-only;
// corrections are recorded through an M5 §164.526-pattern amendment workflow (M30's adaptation of the
// M14 D10 minutes-immutability rule) — the original `minutes_text` is never mutated, an entry is
// appended to the `amendment_log` jsonb array instead. This module is the pure core for both the sign
// transition and the append-only amendment; the route persists + audits around it.
import { WardenXError } from "@wardenx/types";

/** The §2.2 minutes lifecycle state. */
export type MinutesState = "draft" | "signed";

/** §2.2 — an amendment reason must be at least this many characters (§164.526-pattern justification). */
export const QAPI_MINUTES_AMENDMENT_REASON_MIN_CHARS = 20;

/**
 * Sign a `qapi_governance_minutes` row (`draft → signed`). Throws {@link WardenXError}
 * `QAPI_MINUTES_ALREADY_SIGNED` if the minutes are already signed (the sign transition is idempotent at
 * the route via the optimistic-lock version, but the domain rejects a second sign outright). Returns the
 * next state.
 */
export function signMinutes(from: MinutesState): MinutesState {
  if (from === "signed") {
    throw new WardenXError(
      "QAPI_MINUTES_ALREADY_SIGNED",
      "these governance minutes are already signed",
      409,
    );
  }
  return "signed";
}

/** A pending amendment to signed minutes (the caller-supplied entry, validated before it is appended). */
export interface MinutesAmendmentInput {
  /** ISO-8601 timestamp the amendment was recorded. */
  readonly at: string;
  /** The M2 membership id of the author recording the amendment. */
  readonly byMembershipId: string;
  /** The §164.526-pattern justification (≥ {@link QAPI_MINUTES_AMENDMENT_REASON_MIN_CHARS} chars). */
  readonly reason: string;
}

/**
 * Append an amendment to a signed minutes row's `amendment_log` (§2.2, §164.526 pattern). Throws
 * {@link WardenXError} `QAPI_MINUTES_NOT_SIGNED` if the minutes are still a draft (drafts are edited in
 * place — there is nothing to amend yet), or `QAPI_MINUTES_AMENDMENT_REASON_TOO_SHORT` if the reason is
 * too short. Returns a NEW log array with the entry appended — the prior entries are never mutated
 * (append-only immutability). The route persists the returned array.
 */
export function appendMinutesAmendment(
  state: MinutesState,
  currentLog: schema.MinutesAmendmentLog,
  amendment: MinutesAmendmentInput,
): schema.MinutesAmendmentLog {
  if (state !== "signed") {
    throw new WardenXError(
      "QAPI_MINUTES_NOT_SIGNED",
      "only signed governance minutes may be amended; a draft is edited in place",
      409,
    );
  }
  if (amendment.byMembershipId.length === 0) {
    throw new WardenXError(
      "QAPI_MINUTES_AMENDMENT_AUTHOR_REQUIRED",
      "an amendment must record the authoring membership id",
      422,
    );
  }
  if (amendment.reason.trim().length < QAPI_MINUTES_AMENDMENT_REASON_MIN_CHARS) {
    throw new WardenXError(
      "QAPI_MINUTES_AMENDMENT_REASON_TOO_SHORT",
      `an amendment requires a justification of at least ${QAPI_MINUTES_AMENDMENT_REASON_MIN_CHARS} characters`,
      422,
    );
  }
  const entry: schema.MinutesAmendmentEntry = {
    at: amendment.at,
    byMembershipId: amendment.byMembershipId,
    reason: amendment.reason,
  };
  return [...currentLog, entry];
}

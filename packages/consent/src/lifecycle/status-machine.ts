// @wardenx/consent — the consent_record status machine (§2.2.1, D1).
//
// M39-T04. Pure transition function over `consent_status`. The append-only model means most
// "edits" are a NEW row (supersession / renewal), not an in-place transition — the only in-place
// transitions are: draft→active (sign), draft→discarded (housekeeping, §2.2.1 M39-F13 — NOT a
// retention event), active→superseded (a newer row supersedes this one), active→revoked (explicit),
// active→expired (tick). `revoked`/`expired`/`superseded` are terminal for the row; the forward path
// is a brand-new consent record (renewal chain, distinct from the supersession chain).
import type { ConsentStatus } from "../interfaces/kinds";
import { type Decision, deny, ok } from "./result";

/** A row that has been discarded from `draft` leaves the live table entirely (§2.2.1). */
export type ConsentRowState = ConsentStatus | "discarded";

export type ConsentStatusEvent =
  | "sign" // draft → active
  | "discardDraft" // draft → discarded (row deleted; housekeeping)
  | "supersede" // active → superseded (a newer row points at this one)
  | "revoke" // active → revoked
  | "tickExpired"; // active → expired (expires_at < now)

const TRANSITIONS: Record<ConsentStatusEvent, { from: ConsentStatus; to: ConsentRowState }> = {
  sign: { from: "draft", to: "active" },
  discardDraft: { from: "draft", to: "discarded" },
  supersede: { from: "active", to: "superseded" },
  revoke: { from: "active", to: "revoked" },
  tickExpired: { from: "active", to: "expired" },
};

/**
 * Resolve the next row state for a status event, enforcing the §2.2.1 invariants:
 * - a `draft` can only sign or discard; it cannot be superseded/revoked/expired;
 * - an `active` row leaves `active` by exactly one of supersede/revoke/tickExpired;
 * - `revoked`/`expired`/`superseded`/`discarded` are terminal — no event re-animates the row.
 */
export function nextConsentStatus(
  current: ConsentRowState,
  event: ConsentStatusEvent,
): Decision<ConsentRowState> {
  const t = TRANSITIONS[event];
  if (current === t.from) return ok<ConsentRowState>(t.to);
  if (current === "revoked")
    return deny(
      "revoked_is_terminal",
      `a revoked consent cannot ${event}; re-grant creates a new record`,
    );
  if (current === t.to) return deny("already_in_state", `consent is already '${current}'`);
  return deny(
    "invalid_transition",
    `cannot '${event}' a consent in state '${current}' (requires '${t.from}')`,
  );
}

/** §2.2.1 invariant: a `draft` row may not carry `supersedes_consent_record_id` — supersession is a
 *  sign-time act, never a draft-time one. */
export function validateDraftHasNoSupersede(
  status: ConsentRowState,
  supersedesConsentRecordId: string | null,
): Decision {
  if (status === "draft" && supersedesConsentRecordId !== null)
    return deny(
      "draft_cannot_supersede",
      "a draft consent cannot set supersedes_consent_record_id",
    );
  return ok();
}

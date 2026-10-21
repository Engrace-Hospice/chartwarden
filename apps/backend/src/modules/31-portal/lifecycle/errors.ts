// apps/backend/src/modules/31-portal/lifecycle/errors.ts — M31-T03 (§2.2–§2.6, §7.1, §7.5, §8.1).
//
// Every guard failure in the M31 portal/telehealth domain raises a `PortalStateError` carrying the
// machine-readable code the §7 workflow tables and the §4.2 route error blocks name. The error extends the
// M1 `ChartWardenError` envelope base (packages/types — NOT the banned packages/foundation) so the M1 Fastify
// error handler renders the exact code + status with no cross-module import edge. Mirrors the M19
// `TriageStateError` / M20 `SafetyStateError` / M16 `BereavementStateError` precedent.
//
// CASING: bare SCREAMING_SNAKE, the M16/M19/M20 dialect. §7.1 spells one status VERBATIM — an expired
// invite is `410 Gone` — so that status is kept exactly and every other code follows the same shape.
//
// FAIL DIRECTION IS PER GUARD. The portal is the most consumer-exposed module (§8), so the session,
// invitation and consent gates all fail CLOSED: a missing/unreadable consent, an expired token or a stale
// session produces a refusal, never a default-allow. The bereaved flip is the one place the answer is a
// *lateral* re-scope rather than a refusal (§7.5), so it raises no error for the expected transition — only
// for an incoherent one (a flip asked for a grant that is already revoked).
import { ChartWardenError } from "@wardenx/types";

/** The §2.3 / §7 / §8.1 machine-readable failure-code catalog → HTTP status. */
export const M31_ERROR_STATUS = {
  // ── §2.2.4 / §7.1 magic-link invitation ────────────────────────────────────────────────────────────
  /** §7.1 VERBATIM — `410 Gone`. The invite token's TTL (72h platform floor / 7-day ceiling) has elapsed.
   *  A `410` (not `404`) tells the caregiver the link WAS real and is now dead, which is the message the
   *  §7.1 negative path renders ("This invitation has expired. Contact your care team for a new invite."). */
  INVITATION_EXPIRED: 410,
  /** §2.2.4 — the invite was revoked by staff before acceptance (`revoked_at` set). Same `410` surface as
   *  expiry: the link is dead and re-issuing is the only path, so the two must be indistinguishable to a
   *  holder who could otherwise tell "revoked" (someone acted) from "expired" (time lapsed). */
  INVITATION_REVOKED: 410,
  /** §2.2.4 — acceptance of a token that names no outstanding invitation. `410`, not `404`: the accept
   *  page must not become an oracle for which tokens were ever minted. */
  INVITATION_NOT_FOUND: 410,
  /** §2.6 — invitation acceptance is idempotent on `token_hash`; a replay AFTER a DIFFERENT account already
   *  bound the token is a collision, not a replay, and must not silently re-bind. (A replay by the SAME
   *  accepted account returns the existing session — that path raises nothing.) */
  INVITATION_ALREADY_BOUND: 409,
  /** §2.3 — the invitation carried a proposed `scope_set` that does not resolve against the grant kind's
   *  platform floor (see `validateScopeSet`); accepting it would mint a grant scoped to nothing coherent. */
  INVITATION_SCOPE_INVALID: 422,

  // ── §2.3 / §6.4 scope-set resolution ───────────────────────────────────────────────────────────────
  /** §2.3 / §6.4 — a tenant overlay tried to LOOSEN a floor-denied category to `true`. Tightening (a
   *  floor-allowed category to `false`) is legal; loosening is the one thing `validateScopeSet` refuses,
   *  because the platform floor is the minimum-necessary ceiling a tenant may only lower. */
  SCOPE_SET_LOOSENS_FLOOR: 422,

  // ── §2.2 / §8.1 portal session lifecycle ───────────────────────────────────────────────────────────
  /** §2.3 — a session-mint whose requested `active_patient_id` is not reachable via any active grant for
   *  the account. §8.1 multi-account-same-person: one M2 user holds N accounts, one per relationship, and a
   *  session scopes to exactly one patient the CURRENT account can reach — never a patient from another. */
  SESSION_PATIENT_UNREACHABLE: 403,
  /** §8.1 — the account is `suspended` or `revoked`. Existing sessions are revoked at the next request
   *  (§2.2.1); a new mint on a non-`active`/`bereaved` account is refused outright. */
  SESSION_ACCOUNT_NOT_ACTIVE: 403,
  /** §8.1 `SESSION_POLICY.portal` — the 30-minute idle window elapsed since `last_active_at`. */
  SESSION_IDLE_EXPIRED: 401,
  /** §8.1 `SESSION_POLICY.portal` — the 8-hour hard cap elapsed since `minted_at`, idle or not. */
  SESSION_HARD_EXPIRED: 401,
  /** §8.1 D3 — a step-up-required action (email/phone change, recording playback) whose TOTP step-up is
   *  absent or older than the 15-minute step-up window. Fails CLOSED on a missing step-up timestamp. */
  SESSION_STEP_UP_REQUIRED: 403,
  /** §8.1 — a portal session may NOT switch organizations (`no org-switch`); the org is pinned for the
   *  session's lifetime. A request carrying a different org than the session was minted under is a routing
   *  fault, refused rather than silently re-scoped. */
  SESSION_ORG_SWITCH_FORBIDDEN: 403,

  // ── invitee SIGN-IN (the pre-org -> portal-session bind; M2 owns authentication, M31 the account binding) ──
  /** The signed-in user holds no (non-revoked) portal account: they authenticated, but nothing here is theirs. */
  SIGN_IN_NO_PORTAL_ACCOUNT: 403,
  /** The account is still `invited`: the invitation has not been accepted, so there is no grant to sign in to. */
  SIGN_IN_ACCOUNT_NOT_ACTIVATED: 403,
  /** The account is `suspended`/`revoked` (lockout). A new bind is refused; existing sessions die at their next request. */
  SIGN_IN_ACCOUNT_NOT_ACTIVE: 403,
  /** The user's email is not verified: a portal session is never bound to an address that never proved itself. */
  SIGN_IN_EMAIL_UNVERIFIED: 403,
  /** The user is suspended/deactivated at the identity layer. */
  SIGN_IN_USER_INACTIVE: 403,
  /** The tenant is not `active`: sign-in is refused (the M2 §11 D19 auth-time rule, applied to the portal). */
  SIGN_IN_ORGANIZATION_NOT_ACTIVE: 403,
  /** The account has no live grant: it can reach no patient, so a session would be scoped to nothing. */
  SIGN_IN_NO_ACTIVE_GRANT: 403,
  /** More than one eligible account (several tenants / relationships): the caller must name one. */
  SIGN_IN_ACCOUNT_SELECTION_REQUIRED: 409,
  /** The session is already org-bound as something else (staff, another account); a session is bound ONCE. */
  SIGN_IN_SESSION_NOT_BINDABLE: 409,
  /** The sign-in port is not bound in this deployment (fail closed, never a fake success). */
  SIGN_IN_UNAVAILABLE: 503,

  // ── §7.5 / D6 the bereaved lateral flip ────────────────────────────────────────────────────────────
  /** §7.5 — the flip was asked to re-scope a grant that is already revoked. The lateral flip preserves the
   *  account row and swaps one ACTIVE grant for a bereaved one; a revoked grant has no live scope to flip,
   *  so re-scoping it would resurrect access the revocation deliberately ended. */
  BEREAVED_FLIP_GRANT_NOT_ACTIVE: 409,
  /** §7.5 — `BereavedPortalScopeProvider` returned no scope for the account. The flip cannot invent a
   *  bereaved scope; without M16's resolution there is nothing to grant, so orphan cleanup (revoke) is the
   *  correct path, not a flip. Fails CLOSED: an unreadable scope is treated as "no bereaved access". */
  BEREAVED_SCOPE_UNAVAILABLE: 409,

  // ── §4.4 / §8.1 the M39 portal-access consent gate ─────────────────────────────────────────────────
  /** §4.4 / §8.1 — the foundation gate: no active M39 consent of the type backing the grant kind is on
   *  file for the patient. Every portal PHI route evaluates this; it fails CLOSED on a missing, expired,
   *  revoked or unreadable consent alike (§8.2 layering — consent absence and consent-read failure produce
   *  the same refusal so a read outage cannot become a disclosure). */
  PORTAL_CONSENT_ABSENT: 403,
} as const;

/** A machine-readable M31 domain failure code (§2.3 / §7 / §8.1). */
export type M31ErrorCode = keyof typeof M31_ERROR_STATUS;

/**
 * A guard / validation failure in the M31 portal/telehealth domain. Carries the precise code so the §5
 * screens can render an exact message; the M1 error handler maps `statusCode` to the HTTP response. Per
 * §2.2 every guard failure surfaces as one of these — never a raw PG exception or a generic error.
 */
export class PortalStateError extends ChartWardenError {
  constructor(code: M31ErrorCode, message: string) {
    super(code, message, M31_ERROR_STATUS[code]);
    this.name = "PortalStateError";
  }
}

/**
 * Throw a {@link PortalStateError} when `condition` is false (guard helper).
 *
 * Declared `asserts condition` rather than returning `void`: a guard that proves a fact and then lets the
 * compiler forget it pushes every caller into a non-null assertion, and a `!` is exactly the shape that
 * survives a later refactor after the guard above it stopped guaranteeing anything.
 */
export function requirePortal(
  condition: boolean,
  code: M31ErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new PortalStateError(code, message);
}

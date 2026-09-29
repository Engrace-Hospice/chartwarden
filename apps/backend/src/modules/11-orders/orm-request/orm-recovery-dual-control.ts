// apps/backend/src/modules/11-orders/orm-request/orm-recovery-dual-control.ts — the TWO-PERSON control on the attested
// lab-transmission recovery's duplicate-risk attestation (F-191, #248). PURE — no I/O.
//
// WHY. F-187/F-188 let ONE person attest `not_received_by_lab`, which re-dispatches the order: a wrong attestation
// orders the test twice at the lab, and the evidence (who at the lab, the lab's reference) is recorded but not
// verifiable. The control now needs a SECOND, DIFFERENT person. The shape is M3 break-glass's (migration 0210's
// `bge_cosigner_distinct`, `BreakGlassStore.cosign`), the closest existing two-person control:
//   • the first call FILES a `pending_cosign` request (it does not execute);
//   • a different authorized person CO-SIGNS it — that alone executes the re-dispatch, in ONE transaction;
//   • the co-signer can never be the requester (a DB CHECK; the WHERE-clause twin turns it into a 409);
//   • either party can CANCEL, and a request no one co-signs LAPSES after `RECOVERY_REQUEST_TTL_MS`;
//   • every execution / cancellation / expiry raises a compliance alert, and a requester who keeps filing them is
//     flagged in that alert's detail.
// `received_by_lab` sends nothing and stays single-person.

const HOUR_MS = 60 * 60_000;

/**
 * How long a pending recovery waits for its co-signature. The dead-ended order stays `failed` and visible while it
 * waits, and the lab's answer ("we never got it") does not go stale in a day; a shorter window would lapse over a
 * night shift, a longer one lets a stale attestation execute against a lab situation that has since changed.
 */
export const RECOVERY_REQUEST_TTL_MS = 24 * HOUR_MS;

/** The look-back for the repeat-attester signal. */
export const RECOVERY_ANOMALY_WINDOW_MS = 24 * HOUR_MS;

/**
 * How many `not_received_by_lab` requests ONE requester may file inside {@link RECOVERY_ANOMALY_WINDOW_MS} before the
 * execution alert flags it (counting the one being executed). Three: one is the normal case, two happens when a lab
 * call resolves two orders, three in a day is a pattern worth a compliance officer's eye. Injectable.
 */
export const RECOVERY_ANOMALY_THRESHOLD = 3;

export type RecoveryRequestStatus = "pending_cosign" | "executed" | "cancelled" | "expired";

/** What the pure decisions read off a request row. */
export interface RecoveryRequestFacts {
  readonly status: string;
  readonly requestedByUserId: string;
  readonly expiresAt: Date;
}

export type RecoveryCosignRefusalCode = "not_pending" | "expired" | "self_cosign" | "no_actor";

export type RecoveryCosignVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: RecoveryCosignRefusalCode; readonly message: string };

/**
 * May `actorUserId` co-sign this request at `now`? Order matters and follows break-glass: a SETTLED or lapsed request
 * reports that, never whether the caller happens to be its requester. The database enforces the same three facts (the
 * UPDATE's WHERE + the `order_recovery_request_cosigner_distinct_chk` CHECK); this exists so the refusal names its
 * reason and so the rule is unit-testable without a database.
 */
export function decideRecoveryCosign(
  request: RecoveryRequestFacts,
  actorUserId: string,
  now: Date,
): RecoveryCosignVerdict {
  if (!actorUserId) {
    return { ok: false, code: "no_actor", message: "a co-signature needs an authenticated user" };
  }
  if (request.status !== "pending_cosign") {
    return {
      ok: false,
      code: "not_pending",
      message: `this recovery request is ${request.status}, not awaiting a co-signature`,
    };
  }
  if (request.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, code: "expired", message: "this recovery request has expired — file a new one" };
  }
  if (request.requestedByUserId === actorUserId) {
    return {
      ok: false,
      code: "self_cosign",
      message: "a recovery must be co-signed by a different person than the one who requested it",
    };
  }
  return { ok: true };
}

/** Is this requester's filing a repeat? `priorCount` = their OTHER requests inside the window; the one at hand counts. */
export function isRepeatAttester(priorCount: number, threshold: number = RECOVERY_ANOMALY_THRESHOLD): boolean {
  return priorCount + 1 >= threshold;
}

// ── alerts ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The M36 `alert_severity` values the emitter accepts (`packages/messaging`). */
export type RecoveryAlertSeverity = "info" | "warn" | "critical";

/** The platform-default `alert_rule` keys (`packages/messaging/src/seed/alert-rules.ts`). */
export const RECOVERY_ALERT_KINDS = [
  "m11.order.recovery_executed",
  "m11.order.recovery_cancelled",
  "m11.order.recovery_expired",
] as const;
export type RecoveryAlertKind = (typeof RECOVERY_ALERT_KINDS)[number];

export interface RecoveryAlertFacts {
  readonly orderId: string;
  readonly requestId: string;
  readonly requestedByMembershipId: string | null;
  readonly cosignedByMembershipId?: string | null;
  readonly cancelledByMembershipId?: string | null;
  /** How many `not_received_by_lab` requests the requester filed inside the window (this one included). */
  readonly requesterCountInWindow?: number;
  readonly anomalyThreshold?: number;
}

/**
 * The exact `AlertEmitter.emit()` input for a recovery event. IDS AND COUNTS ONLY: no lab contact name, no lab
 * reference, no patient id — the compliance audience needs to know WHO did WHAT to WHICH order, and the evidence
 * itself lives in the append-only ledger they can open. The correlation id is per (kind, request): `alert` is unique on
 * `(organization_id, correlation_id)` and dedupes silently, so it must differ for every request (F-188's lesson).
 */
export function buildRecoveryAlert(
  kind: RecoveryAlertKind,
  facts: RecoveryAlertFacts,
): {
  readonly eventType: RecoveryAlertKind;
  readonly payload: Record<string, unknown>;
  readonly severity: RecoveryAlertSeverity;
  readonly correlationId: string;
} {
  const threshold = facts.anomalyThreshold ?? RECOVERY_ANOMALY_THRESHOLD;
  const count = facts.requesterCountInWindow ?? 0;
  const anomaly = kind === "m11.order.recovery_executed" && count >= threshold;
  const severity: RecoveryAlertSeverity =
    kind === "m11.order.recovery_executed" ? (anomaly ? "critical" : "warn") : kind === "m11.order.recovery_expired" ? "warn" : "info";
  return {
    eventType: kind,
    payload: {
      orderId: facts.orderId,
      requestId: facts.requestId,
      requestedByMembershipId: facts.requestedByMembershipId,
      cosignedByMembershipId: facts.cosignedByMembershipId ?? null,
      cancelledByMembershipId: facts.cancelledByMembershipId ?? null,
      // The repeat-attester signal: a count and a flag, never a name.
      requesterRequestsInWindow: count,
      repeatAttesterThreshold: threshold,
      repeatAttester: anomaly,
      deepLink: `/orders/${facts.orderId}`,
    },
    severity,
    correlationId: `m11-recovery:${kind}:${facts.requestId}`,
  };
}

/** The M36 `AlertEmitter` seam's structural shape — declared locally (M11 never imports a concrete M36 package). */
export interface RecoveryAlertPort {
  emit(
    organizationId: string,
    input: {
      readonly eventType: string;
      readonly payload: Record<string, unknown>;
      readonly severity: string;
      readonly correlationId: string;
    },
  ): Promise<unknown>;
}

/** The knobs a composition root (or a test) can set on the recovery control; every one has a documented default. */
export interface RecoveryControls {
  readonly alerts?: RecoveryAlertPort;
  readonly ttlMs?: number;
  readonly anomalyWindowMs?: number;
  readonly anomalyThreshold?: number;
  readonly now?: () => Date;
}

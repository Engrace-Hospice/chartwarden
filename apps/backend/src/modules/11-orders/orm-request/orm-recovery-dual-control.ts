// apps/backend/src/modules/11-orders/orm-request/orm-recovery-dual-control.ts — the TWO-PERSON control on the attested
// lab-transmission recovery's duplicate-risk attestation (F-194, #248). PURE — no I/O.
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
//
// F-195 — the residual risks of that control, mitigated (none of them VERIFIES the lab; that cannot be done from inside
// the platform — they make a false attestation costlier and louder):
//   • COLLUSION: a requester, or a requester/co-signer PAIR, that has already executed `RECOVERY_ESCALATION_THRESHOLD`
//     recoveries in the window can only be co-signed by a holder of `orders.transmission.cosign_escalated`
//     (`decideRecoveryEscalation`); a repeated pair and a high per-org rate raise CRITICAL, window-deduplicated alerts.
//   • STRANDED requests are superseded by the order's own transitions (a trigger, migration 0272) — see `superseded`.
//   • DURABLE alerts: every alert is now an outbox event published in the recovery's own transaction and delivered to M36
//     by a consumer, so a failure after commit is retried instead of lost.

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

export type RecoveryRequestStatus = "pending_cosign" | "executed" | "cancelled" | "expired" | "superseded";

/**
 * F-195 — the bound. How many EXECUTED `not_received_by_lab` recoveries one requester (or one requester/co-signer pair,
 * either way round) may have inside {@link RECOVERY_ANOMALY_WINDOW_MS} before the NEXT one needs a co-signer holding
 * `orders.transmission.cosign_escalated`. Three: one is normal, two happens when a lab call resolves two orders, a third in
 * a day is a pattern. Injectable; an invalid env value falls back to this rather than disabling the bound.
 */
export const RECOVERY_ESCALATION_THRESHOLD = 3;

/** F-195 — executed recoveries across the WHOLE org inside the window that raise the (deduplicated) rate alert. */
export const RECOVERY_ORG_RATE_THRESHOLD = 10;

/** Parse a bound from an env-style string: an integer in `[min, max]`, else `fallback` (never NaN, never "off"). */
export function parseRecoveryBound(raw: string | undefined, fallback: number, min = 2, max = 100_000): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export type RecoveryEscalationReason = "requester_bound" | "pair_bound";

/**
 * Does THIS co-signature need the high-trust key? `requesterExecuted` = executed recoveries this requester attested in
 * the window; `pairExecuted` = executed recoveries between this exact pair (either way round). Either at the bound ⇒ yes.
 */
export function decideRecoveryEscalation(
  counts: { readonly requesterExecuted: number; readonly pairExecuted: number },
  threshold: number = RECOVERY_ESCALATION_THRESHOLD,
): { readonly required: false } | { readonly required: true; readonly reason: RecoveryEscalationReason } {
  if (counts.pairExecuted >= threshold) return { required: true, reason: "pair_bound" };
  if (counts.requesterExecuted >= threshold) return { required: true, reason: "requester_bound" };
  return { required: false };
}

/** What the pure decisions read off a request row. */
export interface RecoveryRequestFacts {
  readonly status: string;
  readonly requestedByUserId: string;
  readonly expiresAt: Date;
  /** F-195 — why a `superseded` request can no longer execute (a fixed token). */
  readonly supersededReason?: string | null;
}

export type RecoveryCosignRefusalCode =
  | "not_pending"
  | "superseded"
  | "expired"
  | "self_cosign"
  | "no_actor"
  | "escalation_required";

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
  if (request.status === "superseded") {
    return {
      ok: false,
      code: "superseded",
      message: `this recovery request was superseded (${request.supersededReason ?? "the order changed"}) and can no longer execute — re-check the order and file a new one if it is still failed`,
    };
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
/** F-195 — the collusion / rate signal (a repeated requester/co-signer pair, a high org-wide rate). Always critical. */
export const RECOVERY_ANOMALY_ALERT_KIND = "m11.order.recovery_anomaly" as const;
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
  /** F-195 — executed recoveries between THIS pair inside the window (this one included). */
  readonly pairExecutionsInWindow?: number;
  /** F-195 — the co-signature came from a `cosign_escalated` holder because the bound had been reached. */
  readonly escalatedCosign?: boolean;
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
  const pairCount = facts.pairExecutionsInWindow ?? 0;
  const repeatPair = kind === "m11.order.recovery_executed" && pairCount >= threshold;
  const anomaly = kind === "m11.order.recovery_executed" && (count >= threshold || repeatPair);
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
      repeatAttester: kind === "m11.order.recovery_executed" && count >= threshold,
      // F-195 — the pair signal and whether the bound forced a high-trust co-signer. Counts and flags, never a name.
      pairExecutionsInWindow: pairCount,
      repeatPair,
      escalatedCosign: facts.escalatedCosign === true,
      deepLink: `/orders/${facts.orderId}`,
    },
    severity,
    correlationId: `m11-recovery:${kind}:${facts.requestId}`,
  };
}

export type RecoveryAnomalySignal = "repeat_pair" | "org_rate";

/**
 * F-195 — the collusion / rate alert: CRITICAL, and DEDUPLICATED per window by its correlation id (`alert` is unique on
 * `(organization_id, correlation_id)` and absorbs a repeat silently), so a pair that keeps going pages compliance once
 * per window, not once per recovery — the per-recovery `recovery_executed` alert (critical for a repeated pair) already
 * carries each execution. IDS AND COUNTS ONLY: the pair is two user ids (identifiers, not content).
 */
export function buildRecoveryAnomalyAlert(
  signal: RecoveryAnomalySignal,
  facts: {
    readonly orderId: string;
    readonly at: Date;
    readonly windowMs: number;
    readonly executionsInWindow: number;
    readonly threshold: number;
    /** `repeat_pair` only — the two user ids, in any order (sorted here so the correlation id is symmetric). */
    readonly pairUserIds?: readonly [string, string];
  },
): {
  readonly eventType: typeof RECOVERY_ANOMALY_ALERT_KIND;
  readonly payload: Record<string, unknown>;
  readonly severity: RecoveryAlertSeverity;
  readonly correlationId: string;
} {
  const bucket = Math.floor(facts.at.getTime() / facts.windowMs);
  const pair = facts.pairUserIds ? [...facts.pairUserIds].sort() : null;
  return {
    eventType: RECOVERY_ANOMALY_ALERT_KIND,
    payload: {
      signal,
      orderId: facts.orderId,
      executionsInWindow: facts.executionsInWindow,
      threshold: facts.threshold,
      windowHours: Math.round(facts.windowMs / HOUR_MS),
      pairUserIds: pair,
      deepLink: `/orders/${facts.orderId}`,
    },
    severity: "critical",
    correlationId: `m11-recovery:anomaly:${signal}:${pair ? `${pair[0]}:${pair[1]}:` : ""}${bucket}`,
  };
}

/**
 * F-195 — the alert INTENT an M11 transaction publishes as `m11.order.recovery_alert_requested`. The recovery's own
 * transaction writes it, so it commits or rolls back WITH the recovery; a consumer delivers it to M36 and the transactional
 * outbox retries a failed delivery. The alert's own correlation id makes the redelivery idempotent.
 */
export function recoveryAlertEventPayload(alert: {
  readonly eventType: string;
  readonly severity: string;
  readonly correlationId: string;
  readonly payload: Record<string, unknown>;
}): { alertType: string; severity: string; correlationId: string; alertPayload: Record<string, unknown> } {
  return {
    alertType: alert.eventType,
    severity: alert.severity,
    correlationId: alert.correlationId,
    alertPayload: alert.payload,
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
  /**
   * @deprecated F-195 — alerts are DURABLE now: the service publishes `m11.order.recovery_alert_requested` in the
   * recovery's own transaction and `buildM11RecoveryAlertConsumer` delivers it to the emitter. Optional and unused by
   * the service, kept so an older composition root still compiles.
   */
  readonly alerts?: RecoveryAlertPort;
  readonly ttlMs?: number;
  readonly anomalyWindowMs?: number;
  readonly anomalyThreshold?: number;
  /** F-195 — see {@link RECOVERY_ESCALATION_THRESHOLD}. */
  readonly escalationThreshold?: number;
  /** F-195 — see {@link RECOVERY_ORG_RATE_THRESHOLD}. */
  readonly orgRateThreshold?: number;
  readonly now?: () => Date;
}

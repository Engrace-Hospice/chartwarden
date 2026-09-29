// apps/backend/src/modules/11-orders/orm-request/stuck-recovery.ts — the PURE rules for getting a lab order out of a
// stuck state without waiting for a human to notice (F-191, #248). No I/O: the DB shell is
// `../stuck-transmission-recovery.ts`, this file is what makes its decisions unit-testable.
//
// TWO DIFFERENT KINDS OF STUCK, WITH OPPOSITE ANSWERS.
//
//  1. REFUSED BEFORE ANY OUTBOUND ROW EXISTED (`orm_refused:*` from the producer, `dispatch_refused:*` from M29's
//     worker). The cause is a configuration or data fact OUTSIDE the order — a lapsed BAA, an unlinked feed, an
//     incomplete MSH identity, an unconfirmed physician NPI — and nothing was ever sent, so re-emitting can never put a
//     second order on the wire. F-182's resend already does exactly this on a human's click. Waiting for the click after
//     the cause was fixed is the only cost, so these are retried AUTOMATICALLY — but BOUNDED (attempts, backoff, and a
//     window), because a permanently broken configuration must not loop and re-alert the ordering provider on every
//     round trip (each refusal that flips an order `failed` raises `transmission_terminal_failed`).
//  2. FAILED AFTER A MESSAGE WAS BUILT (`dlq_exhausted` — including F-183's "held, delivery unverified" — and
//     `application_reject`). The lab MAY have the order; re-emitting could order the test twice. These are NEVER retried
//     automatically. What was missing is that nothing told anyone they were waiting, so they get a WORKLIST and an AGING
//     ESCALATION (warn, then critical) — the human step stays human, it just stops being invisible.
import {
  DISPATCH_REFUSED_PREFIX,
  type OrmResendCandidate,
  RECOVERABLE_M29_FAILURE_REASONS,
  RECOVERY_BLOCKED_PREFIX,
  classifyOrmResend,
} from "./orm-resend";

// ── auto-retry bounds ────────────────────────────────────────────────────────────────────────────────────────────────

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * At most this many RE-EMISSIONS per order. Only an actual re-emission counts: a sweep that checks and finds the cause
 * still present (or the producer still refusing) spends nothing.
 */
export const AUTO_RETRY_MAX_ATTEMPTS = 5;

/**
 * The wait after the Nth re-emission before the (N+1)th may go — one step per wait that can happen, so exactly
 * `MAX_ATTEMPTS - 1` of them (the bound ends the sweep at the Nth; a further step would be unreachable). The causes being
 * waited out are operational — a BAA renewed, a feed linked, an NPI confirmed — but each retry is only spent once the
 * cause has ALREADY cleared (the BAA pre-check, the producer's own gates), so a re-emission that fails again is a new
 * problem, not the old one: start short (a transient `dependency_unavailable` clears fast) and stretch to hours.
 * Cumulative worst case between the first and the last attempt ≈ 8.7 h. Indexed by the attempts already made
 * (`count - 1`).
 */
export const AUTO_RETRY_BACKOFF_MS: readonly number[] = [10 * MINUTE_MS, 30 * MINUTE_MS, 2 * HOUR_MS, 6 * HOUR_MS];

/**
 * How long after the order last became `failed` the sweep keeps looking at it. It bounds the WORK a permanently broken
 * order costs (it is re-checked every tick until the window closes) and it is the point at which the sweep stops
 * waiting and tells an operator. Measured from the LATEST failure, so every re-emission that fails again restarts it —
 * the attempt bound above is what ends a flapping order, this is what ends a silent one.
 */
export const AUTO_RETRY_WINDOW_MS = 72 * HOUR_MS;

/** The ordering the sweep's own candidate query reads in — the oldest failure first, at most this many per tick. */
export const AUTO_RETRY_BATCH_SIZE = 200;

// ── auto-retry eligibility ───────────────────────────────────────────────────────────────────────────────────────────

/** The one worker refusal whose cause the sweep can verify BEFORE re-emitting (M29's BAA gate). */
export const BAA_REFUSAL_REASON = `${DISPATCH_REFUSED_PREFIX}baa_inactive`;

export interface AutoRetryCandidate extends OrmResendCandidate {
  readonly autoRetryCount: number;
  readonly autoRetryAt: Date | null;
  readonly autoRetryExhaustedAt: Date | null;
  /** When the applier last marked the order `failed` (`order_record.updated_at`). */
  readonly failedAt: Date;
}

export type AutoRetrySkip =
  /** Not a failure the sweep may act on at all — see {@link classifyOrmResend} (SUD, an immutable-order refusal, an
   *  M29-terminal failure, an order that is not an active `failed` lab order). NEVER retried automatically. */
  | "not_eligible"
  /** The sweep already gave up on this order (its one operator alert was raised). */
  | "exhausted_already"
  /** Still inside the wait after the last re-emission. */
  | "backoff";

export type AutoRetryVerdict =
  | { readonly action: "retry"; readonly needsBaaCheck: boolean }
  | { readonly action: "exhausted"; readonly why: "attempts" | "window" }
  | { readonly action: "skip"; readonly why: AutoRetrySkip };

/**
 * PURE. What the sweep does with one `failed` lab order right now.
 *
 * Eligibility is F-182's own {@link classifyOrmResend} — the single source of truth for what a re-emission may touch —
 * so the two paths cannot drift: an SUD-restricted refusal (a disclosure gate, not a data fix), a refusal that lives in
 * the immutable signed order, and any M29-terminal failure are refused there and therefore here. Only `orm_refused:*` and
 * `dispatch_refused:*` survive it; `recovery_blocked:*` and the M29-terminal reasons do not (an outbound row EXISTS).
 */
export function classifyAutoRetry(
  order: AutoRetryCandidate,
  now: Date,
  bounds: { readonly windowMs?: number; readonly maxAttempts?: number } = {},
): AutoRetryVerdict {
  const windowMs = bounds.windowMs ?? AUTO_RETRY_WINDOW_MS;
  const maxAttempts = bounds.maxAttempts ?? AUTO_RETRY_MAX_ATTEMPTS;

  if (!classifyOrmResend(order).ok) return { action: "skip", why: "not_eligible" };
  if (order.autoRetryExhaustedAt !== null) return { action: "skip", why: "exhausted_already" };

  if (order.autoRetryCount >= maxAttempts) return { action: "exhausted", why: "attempts" };
  if (now.getTime() - order.failedAt.getTime() > windowMs) return { action: "exhausted", why: "window" };

  if (order.autoRetryCount > 0 && order.autoRetryAt !== null) {
    const step = AUTO_RETRY_BACKOFF_MS[Math.min(order.autoRetryCount - 1, AUTO_RETRY_BACKOFF_MS.length - 1)] as number;
    if (now.getTime() < order.autoRetryAt.getTime() + step) return { action: "skip", why: "backoff" };
  }
  return { action: "retry", needsBaaCheck: order.transmissionFailureReason === BAA_REFUSAL_REASON };
}

// ── held orders: the worklist and the aging escalation ───────────────────────────────────────────────────────────────

/**
 * Is this failure one an operator must resolve with the lab? `dlq_exhausted` (incl. F-183's "held, delivery
 * unverified") and `application_reject` are M29-terminal failures the attested recovery acts on; `recovery_blocked:*` is
 * an attested re-dispatch the worker could not honour because an outbound row owns the order (F-188) — recoverable again
 * only through the attested path. All three mean "a message may already be at the lab; a human decides".
 */
export function isHeldReason(reason: string | null): boolean {
  if (reason === null) return false;
  return RECOVERABLE_M29_FAILURE_REASONS.has(reason) || reason.startsWith(RECOVERY_BLOCKED_PREFIX);
}

/** Where a held order is in the escalation ladder. `none` = still inside the grace period. */
export type HeldStage = "none" | "warn" | "critical";

/** Defaults (documented in the F-191 history entry): a held order pages at 4 h, again — more loudly — at 24 h. */
export const HELD_WARN_AFTER_MS = 4 * HOUR_MS;
export const HELD_CRITICAL_AFTER_MS = 24 * HOUR_MS;

export interface HeldThresholds {
  readonly warnAfterMs: number;
  readonly criticalAfterMs: number;
}

export const DEFAULT_HELD_THRESHOLDS: HeldThresholds = {
  warnAfterMs: HELD_WARN_AFTER_MS,
  criticalAfterMs: HELD_CRITICAL_AFTER_MS,
};

/**
 * Validate operator-supplied thresholds. `critical` must be strictly after `warn` (otherwise the "warn" stage could
 * never be observed), and both must be positive finite numbers. Throws with a message naming the offending value.
 */
export function assertHeldThresholds(t: HeldThresholds): HeldThresholds {
  const ok = (n: number) => Number.isFinite(n) && n > 0;
  if (!ok(t.warnAfterMs) || !ok(t.criticalAfterMs)) {
    throw new Error("held-order thresholds must be positive, finite millisecond values");
  }
  if (t.criticalAfterMs <= t.warnAfterMs) {
    throw new Error("held-order critical threshold must be later than the warn threshold");
  }
  return t;
}

/**
 * The thresholds in force: the defaults, or `M11_HELD_WARN_AFTER_HOURS` / `M11_HELD_CRITICAL_AFTER_HOURS` (positive
 * numbers of hours; either may be set alone). An invalid value THROWS — a boot-time misconfiguration must be loud, never a
 * silently disabled escalation.
 */
export function heldThresholdsFromEnv(env: Readonly<Record<string, string | undefined>>): HeldThresholds {
  const hours = (key: string, fallbackMs: number): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") return fallbackMs;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number of hours (got '${raw}')`);
    return n * HOUR_MS;
  };
  return assertHeldThresholds({
    warnAfterMs: hours("M11_HELD_WARN_AFTER_HOURS", HELD_WARN_AFTER_MS),
    criticalAfterMs: hours("M11_HELD_CRITICAL_AFTER_HOURS", HELD_CRITICAL_AFTER_MS),
  });
}

/** PURE. The stage a held order is at after waiting `ageMs`. */
export function heldStage(ageMs: number, thresholds: HeldThresholds = DEFAULT_HELD_THRESHOLDS): HeldStage {
  if (ageMs >= thresholds.criticalAfterMs) return "critical";
  if (ageMs >= thresholds.warnAfterMs) return "warn";
  return "none";
}

// ── alerts ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The M36 alert kinds this file's sweeps emit. A runtime list (not just a type) so a test can assert every one has a
 * seeded platform-default `alert_rule` — F-188 found that a kind with no rule persists an `alert` with zero recipients,
 * i.e. reaches nobody.
 */
export const M11_STUCK_ORDER_ALERT_KINDS = [
  "m11.order.transmission_held_aging",
  "m11.order.transmission_auto_retry_exhausted",
] as const;
export type M11StuckOrderAlertKind = (typeof M11_STUCK_ORDER_ALERT_KINDS)[number];

/**
 * ONE alert per (order, hold episode, stage) — ever. The `alert` table is unique on `(organization_id,
 * correlation_id)` and a repeat emit returns the existing row without notifying anyone, so a stable id IS the
 * de-duplication. The EPISODE is the order's current attempt id: a recovery that later fails again mints a new attempt,
 * so a genuinely new hold pages again, while every tick within the same hold is absorbed. (F-188 windowed its ids because
 * a feed-level condition recurs indefinitely; a hold on ONE order has a natural start and end, so no window.)
 */
export function heldAgingCorrelationId(orderId: string, attemptId: string | null, stage: "warn" | "critical"): string {
  return `m11-held-aging:${orderId}:${attemptId ?? "none"}:${stage}`;
}

export function autoRetryExhaustedCorrelationId(orderId: string, attemptId: string | null): string {
  return `m11-auto-retry-exhausted:${orderId}:${attemptId ?? "none"}`;
}

// @wardenx/dosespot — §2.7 refill-inbox SLA clock (M12-T04). Pure, IO-free.
//
// A pending refill request that ages in the inbox harms the patient: the §2.7 SLA fires an M36 routine
// alert at 48 hours (`warn`) and a high-severity alert at 72 hours (`critical`). The 72-hour clock is the
// platform default, tenant-tighten-only via `refill_inbox_policy` (the M11 verbal-window precedent). This
// module owns the clock math the hourly `dosespot.refill_sla` cron (§4.8) composes over the pending
// `refill_request` rows:
//   • `validateRefillSlaPolicy` — the tighten-only guard (warn < critical; both within the platform floors).
//   • `computeHoursPending`     — whole hours a request has been pending (`now − received_at`).
//   • `classifyRefillSlaStage`  — the `none | warn | critical` stage for a given hours-pending + policy.
//   • `planRefillSlaAlert`      — the §2.7/§4.9 side-effect plan (outbox + typed M36 alert) for a stage.
// Every fact (received instant, `now`, policy) is injected as data — no `Date.now()`, no DB.
import { type RefillSideEffect } from "./effects";
import { requireRefill } from "./errors";

/** §2.7 — the platform-default warn threshold: a pending refill ageing past 48h emits the routine alert. */
export const REFILL_SLA_WARN_FLOOR_HOURS = 48;

/** §2.7 — the platform-default critical threshold: past 72h emits the high-severity alert (tighten-only). */
export const REFILL_SLA_CRITICAL_FLOOR_HOURS = 72;

/** §2.7 — the resolved per-tenant refill-inbox SLA policy (a projection of `refill_inbox_policy`). */
export interface RefillSlaPolicy {
  readonly warnHours: number;
  readonly criticalHours: number;
}

/** §2.7 — the platform-default SLA policy: 48h warn / 72h critical. */
export const DEFAULT_REFILL_SLA_POLICY: RefillSlaPolicy = {
  warnHours: REFILL_SLA_WARN_FLOOR_HOURS,
  criticalHours: REFILL_SLA_CRITICAL_FLOOR_HOURS,
} as const;

/** The §2.7 SLA stage a pending refill request has reached. */
export type RefillSlaStage = "none" | "warn" | "critical";

/**
 * §2.7 admin — the tighten-only guard on a per-tenant `refill_inbox_policy`. `warnHours` must be in
 * `[1, 48]`, `criticalHours` in `[1, 72]`, and `warnHours < criticalHours`. A value above the platform
 * floor raises `REFILL_SLA_EXCEEDS_FLOOR`; an out-of-order or sub-minimum value raises
 * `REFILL_SLA_HOURS_OUT_OF_RANGE`. The service calls this on `PATCH /admin/refill-inbox-policy`.
 */
export function validateRefillSlaPolicy(policy: RefillSlaPolicy): void {
  requireRefill(
    Number.isInteger(policy.warnHours) && policy.warnHours >= 1,
    "REFILL_SLA_HOURS_OUT_OF_RANGE",
    `warnHours must be an integer ≥ 1 (got ${policy.warnHours}).`,
  );
  requireRefill(
    Number.isInteger(policy.criticalHours) && policy.criticalHours >= 1,
    "REFILL_SLA_HOURS_OUT_OF_RANGE",
    `criticalHours must be an integer ≥ 1 (got ${policy.criticalHours}).`,
  );
  requireRefill(
    policy.warnHours < policy.criticalHours,
    "REFILL_SLA_HOURS_OUT_OF_RANGE",
    `warnHours (${policy.warnHours}) must be strictly less than criticalHours (${policy.criticalHours}).`,
  );
  requireRefill(
    policy.warnHours <= REFILL_SLA_WARN_FLOOR_HOURS,
    "REFILL_SLA_EXCEEDS_FLOOR",
    `warnHours ${policy.warnHours} exceeds the platform floor of ${REFILL_SLA_WARN_FLOOR_HOURS} (tighten-only).`,
  );
  requireRefill(
    policy.criticalHours <= REFILL_SLA_CRITICAL_FLOOR_HOURS,
    "REFILL_SLA_EXCEEDS_FLOOR",
    `criticalHours ${policy.criticalHours} exceeds the platform floor of ${REFILL_SLA_CRITICAL_FLOOR_HOURS} (tighten-only).`,
  );
}

/** §2.7 — whole hours a request has been pending: `floor((now − receivedAt) / 1h)`, never negative. */
export function computeHoursPending(receivedAtIso: string, nowIso: string): number {
  const received = Date.parse(receivedAtIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(received) || Number.isNaN(now)) {
    throw new RangeError("computeHoursPending: received_at / now must be valid ISO instants");
  }
  const ms = now - received;
  if (ms <= 0) return 0;
  return Math.floor(ms / 3_600_000);
}

/**
 * §2.7 — the SLA stage for a pending refill at `hoursPending` under `policy` (default 48/72). `critical`
 * once `hoursPending ≥ criticalHours`, else `warn` once `≥ warnHours`, else `none`. The hourly cron calls
 * this per pending row and emits at most one new alert per escalation per {@link planRefillSlaAlert}.
 */
export function classifyRefillSlaStage(
  hoursPending: number,
  policy: RefillSlaPolicy = DEFAULT_REFILL_SLA_POLICY,
): RefillSlaStage {
  if (hoursPending >= policy.criticalHours) return "critical";
  if (hoursPending >= policy.warnHours) return "warn";
  return "none";
}

/**
 * §2.7 / §4.9 — the side-effect plan for a refill at a given SLA stage: `warn` emits the
 * `m12.refill_request_sla_warn` outbox event + the `refill_request.sla_warn` typed M36 alert; `critical`
 * the `*_sla_critical` pair; `none` emits nothing. The cron suppresses re-emission of an already-emitted
 * stage (the `*_sla_*_emitted_at` marker on the row); this function is the pure stage→effects map.
 */
export function planRefillSlaAlert(
  stage: RefillSlaStage,
): ReadonlyArray<RefillSideEffect> {
  switch (stage) {
    case "warn":
      return [
        { kind: "outbox", event: "m12.refill_request_sla_warn" },
        { kind: "alert", alert: "refill_request.sla_warn" },
      ];
    case "critical":
      return [
        { kind: "outbox", event: "m12.refill_request_sla_critical" },
        { kind: "alert", alert: "refill_request.sla_critical" },
      ];
    case "none":
      return [];
  }
}

// @wardenx/orders — §2.4 D5 standing-order template + spawn engine (M11-T04). PURE, IO-free.
//
// A standing order is a TEMPLATE + SPAWNED-INSTANCE model (D5): the `standing_order` row is the signature
// anchor (the medical director signs it once, CMS 418.106), and each spawn clones `template_data` into a
// fresh `order_record` that starts in `active` directly — bypassing `pending_signature` because the
// template already carries the signature. This module owns the pure spawn math the hourly `orders.standing_
// spawn` cron (scheduled) and the `POST /standing-orders/:id/spawn` route (PRN) both compose:
//   • `assertStandingKindEligible` — only {lab, supply, ancillary_service} may be a template (§2.4).
//   • `computeNextSpawnAt`         — the cadence next-fire instant (daily/weekly/biweekly/monthly/prn).
//   • `isSpawnDue` / `assertSpawnAllowed` — the active/signed/effective-window/max-spawns gate.
//   • `planStandingCreation` / `planStandingSpawn` / `planStandingDiscontinuation` — side-effect plans.
// Every fact (now, the template's status/signature/counters, the org timezone) is injected as data.
import type { IsoInstant, LocalDate, OrderKind, StandingOrderCadence, StandingOrderSpawnedBy, M11EventName } from "@wardenx/types";
import { KIND_CATALOG, STANDING_ELIGIBLE_KINDS } from "../catalog";
import { addCalendarDays, atOrgLocalHour, dayOfWeekIndex, orgLocalDate, weekdayKey, WEEKDAY_KEYS, DEFAULT_ORG_TIME_ZONE, type WeekdayKey } from "./time";
import { type OrderSideEffect } from "./effects";
import { require_ } from "./errors";
import { signerEligible } from "./signer-eligible";

/** §2.4 — the org-local hour-of-day a scheduled spawn fires (W-SO-01 "next monday 06:00 org-tz"). */
export const DEFAULT_SPAWN_HOUR = 6;

/** §2.4 — the `cadence_detail` jsonb shape the cadence math reads (all fields optional per cadence). */
export interface StandingCadenceDetail {
  /** weekly / biweekly — the weekday(s) to spawn on (`'mon'`…`'sun'`). Defaults to the anchor's weekday. */
  readonly daysOfWeek?: readonly WeekdayKey[];
  /** monthly — the day-of-month to spawn on (1–31, clamped to the month's length). Defaults to anchor day. */
  readonly dayOfMonth?: number;
  /** the org-local hour-of-day a scheduled spawn fires. Defaults to {@link DEFAULT_SPAWN_HOUR}. */
  readonly spawnHour?: number;
}

/**
 * §2.4 D5 — guard that `kind` may be a standing-order template. Only `lab` / `supply` / `ancillary_service`
 * are eligible; `dme` / `comfort_kit` / `level_of_care_change` / `recertification` / `idg_requested` raise
 * `STANDING_KIND_NOT_ELIGIBLE`. (`STANDING_ELIGIBLE_KINDS` is derived from the {@link KIND_CATALOG}.)
 */
export function assertStandingKindEligible(kind: OrderKind): void {
  require_(
    STANDING_ELIGIBLE_KINDS.includes(kind),
    "STANDING_KIND_NOT_ELIGIBLE",
    `'${kind}' may not be a standing-order template — only ${STANDING_ELIGIBLE_KINDS.join(", ")} are eligible (§2.4).`,
  );
}

/** Last day-of-month for a `yyyy-mm` (handles leap Februarys). */
function lastDayOfMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * §2.4 D5 — the next scheduled spawn instant strictly after `fromInstant`, per cadence. Returns `null` for
 * `prn` (PRN templates never auto-spawn; they fire only on the clinician's explicit request). All scheduled
 * cadences fire at the org-local `spawnHour` (default 06:00). DST is exact (org-local boundaries resolved
 * per-instant). `weekly`/`biweekly` read `cadenceDetail.daysOfWeek`; `monthly` reads `dayOfMonth`.
 */
export function computeNextSpawnAt(
  cadence: StandingOrderCadence,
  cadenceDetail: StandingCadenceDetail,
  fromInstant: IsoInstant,
  timeZone: string = DEFAULT_ORG_TIME_ZONE,
): IsoInstant | null {
  if (cadence === "prn") return null;
  const spawnHour = cadenceDetail.spawnHour ?? DEFAULT_SPAWN_HOUR;
  const fromDate = orgLocalDate(fromInstant, timeZone);

  if (cadence === "daily") {
    return atOrgLocalHour(addCalendarDays(fromDate, 1), spawnHour, timeZone);
  }

  if (cadence === "weekly" || cadence === "biweekly") {
    const days =
      cadenceDetail.daysOfWeek && cadenceDetail.daysOfWeek.length > 0
        ? cadenceDetail.daysOfWeek
        : [weekdayKey(fromDate)];
    const wanted = new Set(days.map((d) => WEEKDAY_KEYS.indexOf(d)));
    // Scan forward for the earliest configured weekday strictly after `fromDate` (within a week).
    let offset = 1;
    while (offset <= 7) {
      const candidate = addCalendarDays(fromDate, offset);
      if (wanted.has(dayOfWeekIndex(candidate))) break;
      offset += 1;
    }
    // biweekly fires on the same weekday but a fortnight out (one extra week beyond the weekly match).
    const totalOffset = cadence === "biweekly" ? offset + 7 : offset;
    return atOrgLocalHour(addCalendarDays(fromDate, totalOffset), spawnHour, timeZone);
  }

  // monthly — the configured (or anchor) day-of-month next month, clamped to the target month's length.
  const [yStr, mStr, dStr] = fromDate.split("-");
  const year = Number(yStr);
  const month1 = Number(mStr); // 1-based
  const anchorDom = cadenceDetail.dayOfMonth ?? Number(dStr);
  const nextYear = month1 === 12 ? year + 1 : year;
  const nextMonth1 = month1 === 12 ? 1 : month1 + 1;
  const dom = Math.min(anchorDom, lastDayOfMonth(nextYear, nextMonth1));
  const pad = (n: number): string => String(n).padStart(2, "0");
  const nextDate: LocalDate = `${nextYear}-${pad(nextMonth1)}-${pad(dom)}`;
  return atOrgLocalHour(nextDate, spawnHour, timeZone);
}

/** §2.4 — the standing-template facts a spawn is gated on (a projection of the `standing_order` row). */
export interface StandingOrderSpawnFacts {
  readonly status: "active" | "paused" | "expired" | "discontinued";
  /** The template signature anchor — a spawn is illegal until the template is signed (D5). */
  readonly isSigned: boolean;
  readonly effectiveFrom: IsoInstant;
  readonly effectiveUntil?: IsoInstant | null;
  readonly maxSpawns?: number | null;
  readonly spawnCount: number;
}

/** Whether `now` falls inside the template's `[effective_from, effective_until]` bounds (inclusive). */
function withinEffectiveWindow(facts: StandingOrderSpawnFacts, now: IsoInstant): boolean {
  const nowMs = Date.parse(now);
  if (nowMs < Date.parse(facts.effectiveFrom)) return false;
  if (facts.effectiveUntil && nowMs > Date.parse(facts.effectiveUntil)) return false;
  return true;
}

/** Whether the template's `max_spawns` cap (if set) still has headroom. */
function underSpawnCap(facts: StandingOrderSpawnFacts): boolean {
  return facts.maxSpawns == null || facts.spawnCount < facts.maxSpawns;
}

/**
 * §2.4 D5 — the non-throwing spawn-eligibility predicate the hourly `orders.standing_spawn` cron filters
 * on: the template is `active`, signed, inside its effective window, and under its `max_spawns` cap.
 * (`next_spawn_at <= now` is enforced by the worker's index query, not re-checked here.)
 */
export function isSpawnDue(facts: StandingOrderSpawnFacts, now: IsoInstant): boolean {
  return (
    facts.status === "active" &&
    facts.isSigned &&
    withinEffectiveWindow(facts, now) &&
    underSpawnCap(facts)
  );
}

/**
 * §2.4 D5 — the throwing spawn gate the PRN `POST /standing-orders/:id/spawn` route uses to return precise
 * errors: `STANDING_ORDER_NOT_ACTIVE`, `STANDING_ORDER_NOT_SIGNED`, `STANDING_OUTSIDE_EFFECTIVE_WINDOW`,
 * `STANDING_MAX_SPAWNS_REACHED`. (The scheduled worker uses {@link isSpawnDue} for its bulk filter.)
 */
export function assertSpawnAllowed(facts: StandingOrderSpawnFacts, now: IsoInstant): void {
  require_(facts.status === "active", "STANDING_ORDER_NOT_ACTIVE", `the standing order is '${facts.status}', not active.`);
  require_(facts.isSigned, "STANDING_ORDER_NOT_SIGNED", "the standing order is not yet signed (the spawn signature anchor is missing).");
  require_(withinEffectiveWindow(facts, now), "STANDING_OUTSIDE_EFFECTIVE_WINDOW", "the standing order's effective window does not cover now.");
  require_(underSpawnCap(facts), "STANDING_MAX_SPAWNS_REACHED", "the standing order's max_spawns cap has been reached.");
}

/**
 * §2.4 / §5.5 — the create side-effect plan for a new `standing_order`. The template carries a one-time
 * signature (validated here: the signer must be eligible to sign `kind`), so the plan records the audit row
 * and emits `m11.order.standing_created`. Throws `STANDING_KIND_NOT_ELIGIBLE` / `SIGNER_NOT_ELIGIBLE`.
 */
export function planStandingCreation(input: {
  readonly kind: OrderKind;
  readonly signerDiscipline: string;
}): ReadonlyArray<OrderSideEffect> {
  assertStandingKindEligible(input.kind);
  require_(
    signerEligible(input.signerDiscipline, input.kind),
    "SIGNER_NOT_ELIGIBLE",
    `Discipline '${input.signerDiscipline}' is not eligible to sign a '${input.kind}' standing order (§2.1).`,
  );
  return [{ kind: "audit" }, { kind: "outbox", event: "m11.order.standing_created" }];
}

/** §2.4 / §5.5 / §5.6 — the result of a spawn: the spawned `order_record` starts `active` (signature-
 * anchored), a `standing_order_instance` row is written, the template's `next_spawn_at`/`spawn_count`
 * advance, and the spawn-then-sign events fire (plus the kind's downstream signed events, §4.4). */
export interface StandingSpawnPlan {
  /** The spawned order bypasses `pending_signature` — it is born `active` (D5). */
  readonly spawnedOrderStatus: "active";
  readonly spawnedBy: StandingOrderSpawnedBy;
  /** The next scheduled fire to write back to `standing_order.next_spawn_at` (null for PRN). */
  readonly nextSpawnAt: IsoInstant | null;
  /** The ordered §4.4 events the spawn emits in the same transaction. */
  readonly events: ReadonlyArray<M11EventName>;
}

/**
 * §2.4 D5 / W-SO-01 / W-SO-02 — plan a spawn from a signed, active template. Emits `m11.order.standing_
 * spawned` then `m11.order.signed` (the signature is inherited from the template anchor, so the spawned
 * order is born `active`) plus the kind's downstream signed events (e.g. `lab → hl7_orm_requested`). The
 * `nextSpawnAt` is recomputed from `now` for the scheduled path and carried back to the template; the PRN
 * path passes `cadence='prn'` so the schedule is unchanged (`nextSpawnAt=null`).
 */
export function planStandingSpawn(input: {
  readonly kind: OrderKind;
  readonly cadence: StandingOrderCadence;
  readonly cadenceDetail: StandingCadenceDetail;
  readonly spawnedBy: StandingOrderSpawnedBy;
  readonly now: IsoInstant;
  readonly timeZone?: string;
}): StandingSpawnPlan {
  assertStandingKindEligible(input.kind);
  const downstream = KIND_CATALOG[input.kind].downstreamSignedEvents;
  return {
    spawnedOrderStatus: "active",
    spawnedBy: input.spawnedBy,
    nextSpawnAt:
      input.spawnedBy === "system"
        ? computeNextSpawnAt(input.cadence, input.cadenceDetail, input.now, input.timeZone)
        : null,
    events: ["m11.order.standing_spawned", "m11.order.signed", ...downstream],
  };
}

/**
 * §2.4 — discontinue a standing-order template. The template stops spawning (`status='discontinued'`,
 * emits `m11.order.standing_discontinued`); previously-spawned `active` instances continue their own
 * lifecycle UNLESS the clinician elects `alsoDiscontinueInstances`, in which case each active instance is
 * separately discontinued via the order machine with `reason='standing_order_discontinued'` (the caller
 * loops the instances; this plan only carries the template's own effects + the election flag).
 */
export interface StandingDiscontinuationPlan {
  readonly effects: ReadonlyArray<OrderSideEffect>;
  readonly alsoDiscontinueInstances: boolean;
}

export function planStandingDiscontinuation(alsoDiscontinueInstances: boolean): StandingDiscontinuationPlan {
  return {
    effects: [{ kind: "audit" }, { kind: "outbox", event: "m11.order.standing_discontinued" }],
    alsoDiscontinueInstances,
  };
}

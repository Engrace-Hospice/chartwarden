// apps/backend/src/modules/14-idg/jobs/index.ts — M14 background jobs (GAP-092, §4.8 / M14-F01 /
// ADR-0018 D2). Pure, deterministic scan over the §4.8 queue catalog (pure data, no BullMQ import — the
// worker construction binds at app boot, the M7/M9/M10/M25 precedent). Ships the ONE cron GAP-020/091
// left open:
//   • `idg.review-clock-sweep` (daily) — for every patient with an IDG packet in the org, escalate their
//     per-patient 15-day review floor (`last_idg_reviewed_at + 15d`, GAP-020's own anchor) at EXACTLY
//     T-3 / T-0 / T+1 calendar days, emitting `m14.review_clock.escalated` (events-by-m14.ts). This is the
//     ONLY path that catches a floor lapsing from pure inaction — no CANCEL/RESCHEDULE ever attempted, so
//     neither GAP-020's guard nor GAP-091's override composition ever runs at all.
//
// SCOPE (documented, not silent — the M9 reassessment-due-scan precedent for the SAME limitation): M14
// has no published "every actively-admitted patient in an org" seam, and none of M14's `dependsOn`
// modules ([1, 7, 8, 36]) publish one either — this scans M14's OWN `idg_patient_packet` table for every
// DISTINCT patient with at least one packet, not "every patient with an active admission". A patient
// discharged after their last IDG review keeps escalating until they get no new packet ever again (their
// floor stops advancing, so escalation is a one-time T-3/T-0/T+1 burst, not a permanent recurring alarm);
// this is the same accepted bounded cut M9 made for its own cadence scan (`jobs/cron-store.ts`'s
// `latestAssessmentsPerPatientScaleForOrg`).
// F-171 (#248) adds the two crons `jobs/schedule-materialise.ts` / `jobs/packet-build.ts` document as
// genuinely built and wired here — the §7.1 `materialise-future-meetings` worker (a prerequisite: without
// it `idg_meeting` never gets a `scheduled` row for the packet-build cron to find) and the §7.2/§4.9.1
// `tminus-24h-build` T-24h packet-build worker (the real "does the worker exist" answer to the m14
// `handlers-unbound` group's standing F-129/F-164/F-167/F-169 finding).
/** The system actor id every M14 cron stamps on its per-org `withOrgContext` tx (audit attribution).
 * Grepped the repo for every `00000000-0000-0000-0000-0000000000xx` constant first: M7 uses `...07`, M9
 * uses `...09`, M25 uses `...e5`, M26 uses `...e6` — `...14` (M14's own module number) is unused. Lives
 * here (not `cron-workers.ts`, which imports `packet-build.ts`/`schedule-materialise.ts`) so those two
 * files can import it without a `cron-workers.ts` → them → `cron-workers.ts` circular import
 * (`arch:boundaries` no-circular, caught live). */
export const M14_WORKER_SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000014";

/** The M2 active-org enumerator every M14 cron's fan-out reads (runs under withPlatformContext when
 * bound) — the same `cron-workers.ts`-avoiding-circularity reason as {@link M14_WORKER_SYSTEM_USER_ID}. */
export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

export const M14_QUEUES = {
  /** Daily scan: escalate patients past their per-patient 15-day review floor at T-3/T-0/T+1. */
  reviewClockSweep: "idg.review-clock-sweep",
  /** Daily 90-day rolling materialization of `idg_meeting` rows from each `idg_recurring_policy` (§7.1). */
  scheduleMaterialise: "idg.schedule-materialise",
  /** Hourly T-24h packet build — the §4.9.1 `idg.packets-cron` (`tminus-24h-build`) sweep. */
  packetsBuild: "idg.packets-cron",
  /** Hourly §2.7 / §4.9.1 `compute-carry-forward` — carry overdue action items onto the next meeting's agenda. */
  carryForward: "idg.carry-forward",
} as const;

export type M14QueueName = (typeof M14_QUEUES)[keyof typeof M14_QUEUES];

/** BullMQ moves jobs here after `attempts` exhausted; ops alerts off depth (the M9/M10 convention). */
export const M14_DLQ = {
  reviewClockSweep: "idg.review-clock-sweep.dlq",
  scheduleMaterialise: "idg.schedule-materialise.dlq",
  packetsBuild: "idg.packets-cron.dlq",
  carryForward: "idg.carry-forward.dlq",
} as const;

/** The §4.8 cron cadence (the scheduler registers this repeatable). */
export const M14_JOB_SCHEDULES = {
  reviewClockSweep: "0 6 * * *", // daily 06:00 (the M9 cadence-scan precedent)
  scheduleMaterialise: "0 2 * * *", // §7.1 "job runs at 02:00 org-tz" (UTC here; see the file's own header)
  packetsBuild: "0 * * * *", // hourly — the T-24h window tolerates an hour of slack either side
  // hourly at :30 — runs BEFORE the :00 packet build for the same meeting (36h lookahead vs the build's 24h),
  // so a built packet's `carryForwardCount` already includes this meeting's carry.
  carryForward: "30 * * * *",
} as const;

/** Per-queue BullMQ parameters, declared as data so boot worker construction reads one source of truth
 * (the M09-F12 convention: every job declares full parameters). */
export const M14_QUEUE_PARAMS = {
  reviewClockSweep: { priority: 3, attempts: 3, backoff: "exponential 120s", concurrency: 2 },
  // §4.9.1 `idg.packets-cron` (`tminus-24h-build`) priority 7 / attempts 2 / fixed 60s / concurrency 1 —
  // the sweep is a single-threaded per-org/per-meeting scan (per-patient failure isolation is INSIDE the
  // tick, not across concurrent ticks), matching the spec's own §4.9.1 table row exactly.
  packetsBuild: { priority: 7, attempts: 2, backoff: "fixed 60s", concurrency: 1 },
  scheduleMaterialise: { priority: 5, attempts: 3, backoff: "exponential 300s", concurrency: 1 },
  // §4.9.1 `idg.carry-forward` — priority 6 / attempts 3 / exponential 20s / concurrency 5 (the spec row). Safe
  // at 5: the (item, meeting) increment is keyed on the 0285 unique index, proven live under concurrent ticks.
  carryForward: { priority: 6, attempts: 3, backoff: "exponential 20s", concurrency: 5 },
} as const;

// ── `idg.review-clock-sweep` (§4.8 daily / M14-F01 / ADR-0018 D2) ──────────────────────────────────────

/** The M14-F01 15-day review floor (matches `idg-route-service-db.ts`'s `computeReviewFloorBreaches`). */
export const REVIEW_FLOOR_DAYS = 15;

/** The single per-patient projection the sweep evaluates — one row per DISTINCT patient with at least one
 * packet in the org (the store aggregates across ALL the patient's packets; see this file's header). */
export interface ReviewClockSnapshot {
  readonly patientId: string;
  readonly admissionId: string;
  readonly locationId: string;
  /** MAX(last_idg_reviewed_at) across every packet for this patient, or null if never reviewed. */
  readonly lastIdgReviewedAt: string | null;
  /** Fallback origin when never reviewed — the EARLIEST packet's `since_cursor_iso` (the packet worker's
   * own admission-activation-anchored cursor; the same column GAP-020's guard reuses for the same reason). */
  readonly earliestSinceCursorIso: string;
}

/** One patient's escalation for this tick (events-by-m14.ts's `m14.review_clock.escalated` payload shape). */
export interface ReviewClockEscalation {
  readonly patientId: string;
  readonly admissionId: string;
  readonly locationId: string;
  readonly lastIdgReviewedAt: string | null;
  readonly floorAt: string;
  readonly stage: "t_minus_3" | "t_zero" | "t_plus_1";
  readonly severity: "clinical_routine" | "critical";
}

/** Whole calendar-day difference (UTC date-only, ignoring time-of-day) — `a`'s date minus `b`'s date. */
function calendarDaysDiff(a: Date, b: Date): number {
  const aDay = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const bDay = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((aDay - bDay) / 86_400_000);
}

/** The escalation stage `daysUntilFloor` (floor's calendar date minus now's) maps to, or `null` on any
 * other day — exactly three named points, not a repeating reminder window (unlike M25's T-30/14/7/1
 * boundary alerts, which intentionally re-fire every day within a boundary). */
function stageFor(daysUntilFloor: number): "t_minus_3" | "t_zero" | "t_plus_1" | null {
  if (daysUntilFloor === 3) return "t_minus_3";
  if (daysUntilFloor === 0) return "t_zero";
  if (daysUntilFloor === -1) return "t_plus_1";
  return null;
}

/**
 * `idg.review-clock-sweep` (§4.8 daily / M14-F01 / ADR-0018 D2) — for each patient, floor =
 * `(lastIdgReviewedAt ?? earliestSinceCursorIso) + 15 days`; escalate at EXACTLY T-3, T-0, or T+1
 * calendar days from `now`. T-3 is `clinical_routine`; T-0/T+1 tighten to `critical` (alerts-by-m14.ts's
 * own severity note). Fires once per stage under the scheduled daily cadence.
 */
export function planReviewClockSweep(
  patients: readonly ReviewClockSnapshot[],
  now: Date,
): readonly ReviewClockEscalation[] {
  const escalations: ReviewClockEscalation[] = [];
  for (const p of patients) {
    const origin = p.lastIdgReviewedAt ?? p.earliestSinceCursorIso;
    const floorAt = new Date(new Date(origin).getTime() + REVIEW_FLOOR_DAYS * 86_400_000);
    const stage = stageFor(calendarDaysDiff(floorAt, now));
    if (!stage) continue;
    escalations.push({
      patientId: p.patientId,
      admissionId: p.admissionId,
      locationId: p.locationId,
      lastIdgReviewedAt: p.lastIdgReviewedAt,
      floorAt: floorAt.toISOString(),
      stage,
      severity: stage === "t_minus_3" ? "clinical_routine" : "critical",
    });
  }
  return escalations;
}

// apps/backend/src/modules/30-quality/jobs/m30-jobs.ts — M30 Phase-2C LIVE BullMQ wiring for the §4.8 jobs.
//
// The thin, infra-touching adapter that turns the @wardenx/quality PURE processors (the four §4.8 work-queue
// workers + the four crons) into running BullMQ `Worker`s + the cron-schedule `Queue`s. ALL job LOGIC lives
// in the package (unit-tested against in-memory ports); this module only constructs `Worker`/`Queue` over a
// Valkey connection and BINDS each worker's PORTS to real adapters — the M30 repositories (measure-value /
// recompute-queue / cahps / infection / risk-register), the PRIMARY-pool `REFRESH MATERIALIZED VIEW
// CONCURRENTLY` via `db.execute`, the LIVE M10 HOPE consumer (the one consumed seam, handed in via `getSeam`
// at the composition root), and the per-org CAHPS adapter resolver — while the genuinely-unlanded platform
// infra (the transactional-outbox row emit, the M1 envelope-DEK decrypt for CAHPS PHI, the live M36 alert
// router, plus the cross-module read seams with no stable accessor yet) carries a LAZY fail-closed thunk.
// Mirrors apps/backend/src/modules/33-reporting/jobs/m33-jobs.ts EXACTLY (the worker-construction template:
// `new Worker(queue, processor, { connection })` + `new Queue(...)`; injected connection; the caller owns
// lifecycle/close). Nothing here is invoked at import — constructing a Worker is what opens the Valkey
// connection, and that happens only inside these functions (never in tests / at module load).
//
// IMPORTANT (per the Phase-2C split): this file BUILDS the adapters + the workers; it does NOT mount them
// into the app. The Integration agent calls `registerM30Workers` / `registerM30CronWorkers` / `scheduleM30Jobs`
// from the composition root once the Valkey connection + the missing M1 infra seams (the transactional-outbox
// dispatcher, the envelope-DEK helper, the programmatic M36 alert router) and the cross-module read accessors
// (the per-family measure-input provider, the platform active-org enumerator, the death-feed decedent reader)
// are available. Until then the bindable ports are bound and the genuinely-missing ones carry a typed TODO +
// a fail-closed throw (never a silent no-op).
//
// THE M34 EAGER-BIND GOTCHA (followed exactly): a missing port is bound to a LAZY `() => unboundWorkerPort(...)`
// thunk so the throw happens only when a JOB RUNS — never at port-bundle construction. The host MUST boot with
// the BullMQ connection enabled even when an adapter is absent; an eager `unboundWorkerPort(...)` call would
// crash boot.
//
// SAFETY INVARIANTS (§3.3 / §3.6 / §4.8 / §7.x):
//   • the measure-recompute worker append-only inserts the new `quality_measure_value` + soft-supersedes the
//     prior — the backend wraps the processor in ONE `withOrgContext` tx so the pair is atomic (the
//     `uq_quality_measure_value_current` partial-unique is the fail-safe if the envelope is omitted).
//   • the CAHPS PHI-decrypt + vendor-config ports are the genuinely-missing M1 envelope-DEK infra → LAZY
//     fail-closed (the M33 drilldown-encrypt precedent: deny + fail rather than export un-decrypted). With
//     them unbound every `m30.cahps_export` run reaches the §4.8 terminal `export_failed` gate on its final
//     attempt — fail-closed, never a plaintext leak.
//   • the risk-register MV REFRESH runs on the PRIMARY pool (CONCURRENTLY keeps R-95 reads live, D3/D13).
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
  type ActiveOrgListPort,
  type CahpsExportPorts,
  type CahpsMonthlySampleCronPorts,
  CahpsRepository,
  type ComputeHvldlInput,
  type HvldlDecedentInput,
  type HopeSfvOnTimeRateInput,
  type HopeSubmissionAcceptanceRateInput,
  type MeasureRecomputeJob,
  type MeasureRecomputePorts,
  type MeasureRegistration,
  InfectionRepository,
  type NightlyRecomputeCronPorts,
  type OutbreakDetectionJob,
  type OutbreakDetectionPorts,
  type ProcessingLogPort,
  type QualityHopeConsumer,
  QualityMeasureValueRepository,
  MeasureRecomputeQueueRepository,
  type RiskRegisterRefreshCronPorts,
  type RiskRegisterRefreshPorts,
  RiskRegisterRepository,
  type SraRemindersCronPorts,
  type CahpsAdapterResolvePort,
  type ThresholdRule,
  type TimelyFollowUpNonPainInput,
  type TimelyFollowUpPainInput,
  buildMeasureRegistry,
  HCI_THRESHOLDS_v2025,
  HVLDL_MIN_QUALIFYING_VISITS,
  HVLDL_QUALIFYING_DISCIPLINES_v2025,
  HVLDL_QUALIFYING_DISCIPLINES_v2028,
  M30_JOB_SCHEDULES,
  M30_QUEUES,
  M30_QUEUE_PARAMS,
  cahpsExportProcessor,
  cahpsMonthlySampleCronProcessor,
  measureRecomputeProcessor,
  nightlyRecomputeCronProcessor,
  outbreakDetectionProcessor,
  riskRegisterRefreshCronProcessor,
  riskRegisterRefreshProcessor,
  sraRemindersCronProcessor,
  unboundWorkerPort,
} from "@wardenx/quality";
import type {
  DeathDischargeReader,
  HopeRollupPeriod,
  SignedEncountersReader,
} from "@wardenx/types";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { getSeam } from "../../../bootstrap/index";

// ── the dep bag the composition root injects (the bindable infra + the still-missing seams) ────────────

/**
 * The dependencies the live M30 worker wiring binds the §4.8 worker/cron ports over. The Integration agent
 * supplies these at the composition root. Each maps onto the SAME interfaces the package processors already
 * take — this file's job is to BIND them (it never rewrites a processor).
 *
 * The shapes typed here are the ones available in the repo today (the Drizzle client, the Valkey connection,
 * the LIVE M10 HOPE consumer reached via `getSeam`, the per-org CAHPS adapter registry). The cross-module
 * infra a job also needs (the M1 `processing_log` accessor, the per-family measure-input provider, the M2
 * platform active-org enumerator, the death-feed decedent reader, the transactional-outbox dispatcher, the
 * envelope-DEK helper, the M36 alert router) does NOT all have a stable accessor yet — what is absent here
 * is bound to a LAZY `M30WorkerPortUnbound` throw rather than silently no-op'ing.
 */
export interface M30WorkerDeps {
  /** The Valkey/Redis connection the `Worker`/`Queue` open over (injected, same as M33 reporting-jobs). */
  readonly connection: ConnectionOptions;
  /** The org-scoped Drizzle client the repos run under (wrapped per-job in `withOrgContext` by the worker). */
  readonly db: DbClient;
  /**
   * The PRIMARY-pool Drizzle client for the risk-register MV REFRESH (D3 — REFRESH writes on the primary).
   * TODO(integrator): pass M1's primary pool; until it is available the refresh uses `db` (fine in a
   * single-pool dev boot, but NOT the dedicated primary the spec mandates).
   */
  readonly primaryDb?: DbClient;
  /** The LIVE M10 HOPE consumer (bound via `getSeam` at boot — the one consumed seam, §4.4 / M10-real). */
  readonly hope: QualityHopeConsumer;
  /** The per-org CAHPS adapter resolver (a `CahpsAdapterRegistry` seeded from @wardenx/cahps-vendors); a job
   *  for an org with no live binding 503s (degraded, not 404). Fail-closed thunk when absent. */
  readonly cahpsAdapters?: CahpsAdapterResolvePort;
  /** The §4.8 `processing_log` consumer-idempotency guard (bindable over the M1-owned table; fail-closed
   *  until that accessor lands — bindable, not platform-deferred). */
  readonly processingLog?: ProcessingLogPort;
  /** The platform active-org enumerator the crons fan out across (M2 org reader under `withPlatformContext`). */
  readonly activeOrgs?: ActiveOrgListPort;
  /**
   * The platform measure registry keyed by measure code (each catalog descriptor bound to its concrete pure
   * calculator). Defaults to the FULL `buildMeasureRegistry()` (HCI ten indicators + composite, HVLDL, the
   * two HOPE-derived, the fifteen operational measures) so a recompute resolves its calculator by code; a
   * measure with no registration still fails closed loudly (`MeasureRegistrationMissing`). Override only to
   * narrow the active set (e.g. a per-FY subset).
   */
  readonly registrations?: ReadonlyMap<string, MeasureRegistration>;
  /**
   * The M6 death-discharge census reader the HVLDL recompute reads its denominator from (§4.11). Resolved
   * via `getSeam` at the composition root (M6-owned, leaf-typed); the impl self-scopes each call to the
   * org on its own connection. Fail-closed thunk when absent (HVLDL recompute denies until bound).
   */
  readonly deathDischargeReader?: DeathDischargeReader;
  /**
   * The M8 signed-encounter reader the HVLDL recompute counts EVV-verified qualifying-discipline visits in
   * the last days of life through (§4.7 `SignedEncountersReader`). Resolved via `getSeam` at the composition
   * root; the impl self-scopes each call. Fail-closed thunk when absent.
   */
  readonly signedEncounters?: SignedEncountersReader;
  /** Injected clock (deterministic in tests; the package processors stamp every instant through this). */
  now?: () => Date;
}

// ── deterministic reproducibility-snapshot hash (V-5; the `hashSnapshot` port the recompute worker takes) ─

/** Canonical (key-sorted) JSON so an identical snapshot always hashes identically regardless of key order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

/** sha256 (hex) over the canonicalised reproducibility snapshot (V-5 — identical inputs ⇒ identical hash). */
function hashSnapshot(snapshot: unknown): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

// ── the HOPE-family measure-input resolver (binds `measureRecompute.data.resolveInput` for the 4 HOPE measures) ─

/**
 * The per-measure `ThresholdRule` the four HOPE-family calculators each take in their input. No per-FY HOPE
 * threshold table exists in @wardenx/quality (unlike `HCI_THRESHOLDS_v2025`), so the resolver supplies a
 * documented platform default per measure. All four are higher-is-better (`gte`).
 *
 * ★ ASSUMPTION (flagged): only `hope_submission_acceptance_rate`'s 0.90 is CMS-sourced (the §1.3 APU floor —
 *   the calculator's own doc-comment states "CMS APU floor is 90%"). The other three 0.90 targets are
 *   PLATFORM DEFAULTS pending a CMS HOPE technical-spec refresh (the `HCI_THRESHOLDS_v2025` precedent — a
 *   single reviewed constant a tenant may TIGHTEN via `qapi_indicator`, never loosen below). When the FY2028
 *   HOPE measure specs publish, replace these with a versioned `HOPE_THRESHOLDS_v<FY>` table in the package.
 */
const HOPE_MEASURE_THRESHOLDS: Readonly<Record<string, ThresholdRule>> = {
  tfp_pi: { value: 0.9, direction: "gte", label: "timely SFV follow-up for pain impact (platform default)" },
  tfp_npsi: {
    value: 0.9,
    direction: "gte",
    label: "timely SFV follow-up for non-pain symptom impact (platform default)",
  },
  hope_sfv_on_time_rate: { value: 0.9, direction: "gte", label: "HOPE SFV on-time rate (platform default)" },
  hope_submission_acceptance_rate: {
    value: 0.9,
    direction: "gte",
    label: "HOPE submission acceptance — CMS APU floor (§1.3)",
  },
};

/** Resolve the documented threshold for a HOPE-family measure (fail-closed if a code has no default). */
function hopeThresholdFor(measureCode: string): ThresholdRule {
  const rule = HOPE_MEASURE_THRESHOLDS[measureCode];
  if (rule === undefined) {
    return unboundWorkerPort(
      "measureRecompute.data.resolveInput.threshold",
      `no HOPE-family threshold default registered for measure '${measureCode}' — add it to HOPE_MEASURE_THRESHOLDS`,
    );
  }
  return rule;
}

/**
 * The per-family measure-input provider for the FOUR HOPE-family measures (the `MeasureInputProviderPort`
 * the `m30.measure_recompute` worker calls at its single seam reach, §7.1). It shapes the LIVE M10
 * `HopeOrgRollupProvider` org-rollup COUNTS (the one consumed seam — §4.4 / D6 AGGREGATE-ONLY, no patient
 * rows cross) into each calculator's already-fetched input + the per-measure threshold.
 *
 * The rollup window is `[periodStart, periodEnd)` (the `ComputeMeasureInput` base — inclusive-from /
 * exclusive-to, mapped straight onto `HopeRollupPeriod.from`/`.to`). Org scope is the explicit
 * `organizationId` (the producer's Drizzle reader also runs under the worker's `withOrgContext` RLS).
 *
 * Any OTHER measure code stays FAIL-CLOSED: the non-HOPE families (HCI / HVLDL / the operational measures)
 * consume the M5–M18 read seams the integrator has not bound here yet, so an attempt to recompute one
 * throws the typed `unboundWorkerPort` rather than computing on an empty input.
 */
export async function resolveHopeMeasureInput(
  request: {
    readonly registration: MeasureRegistration;
    readonly organizationId: string;
    readonly providerEntityId: string;
    readonly periodStart: string;
    readonly periodEnd: string;
  },
  seams: { readonly hope: QualityHopeConsumer },
): Promise<unknown> {
  const { organizationId, providerEntityId, periodStart, periodEnd } = request;
  const code = request.registration.code;
  const period: HopeRollupPeriod = { from: periodStart, to: periodEnd };
  const base = { organizationId, providerEntityId, periodStart, periodEnd } as const;

  switch (code) {
    case "tfp_pi": {
      const rollup = await seams.hope.j2051FollowUpRollup(organizationId, period);
      const input: TimelyFollowUpPainInput = {
        ...base,
        qualifyingPainImpactTriggers: rollup.painTriggers,
        followUpVisitsWithinWindow: rollup.painFollowUpsInWindow,
        threshold: hopeThresholdFor(code),
      };
      return input;
    }
    case "tfp_npsi": {
      const rollup = await seams.hope.j2051FollowUpRollup(organizationId, period);
      const input: TimelyFollowUpNonPainInput = {
        ...base,
        qualifyingNonPainImpactTriggers: rollup.nonPainTriggers,
        followUpVisitsWithinWindow: rollup.nonPainFollowUpsInWindow,
        threshold: hopeThresholdFor(code),
      };
      return input;
    }
    case "hope_sfv_on_time_rate": {
      const rollup = await seams.hope.sfvTimelinessRollup(organizationId, period);
      const input: HopeSfvOnTimeRateInput = {
        ...base,
        sfvDue: rollup.sfvDue,
        sfvOnTime: rollup.sfvOnTime,
        threshold: hopeThresholdFor(code),
      };
      return input;
    }
    case "hope_submission_acceptance_rate": {
      const rollup = await seams.hope.submissionPostureRollup(organizationId, period);
      const input: HopeSubmissionAcceptanceRateInput = {
        ...base,
        submissions: rollup.submissions,
        acceptedSubmissions: rollup.acceptedSubmissions,
        threshold: hopeThresholdFor(code),
      };
      return input;
    }
    default:
      return unboundWorkerPort(
        "measureRecompute.data.resolveInput",
        `no measure-input provider bound for '${code}' — only the four HOPE-family measures (tfp_pi / tfp_npsi / hope_sfv_on_time_rate / hope_submission_acceptance_rate) resolve from the live M10 HOPE rollups; the non-HOPE families need the M5–M18 read seams`,
      );
  }
}

// ── the OPERATIONAL measure-input resolver (visit-on-time + EVV compliance) ────────────────────────────

/**
 * The two operational measures whose producers already tally ORG-LEVEL counts (M17 scheduling, M18 EVV).
 *
 * These could not be bound before because the producer seams returned a RATE. `ratioResult()` suppresses a
 * measure whose DENOMINATOR is below the CMS reportable floor, so a rate — which has already discarded the
 * denominator — cannot drive a reportable measure, and back-computing one would publish a rate CMS requires
 * withheld. M17/M18 now expose `getOnTimeVisitCounts` / `getComplianceCounts` beside their rate methods
 * (the tallies were always in their stores; the division at the seam boundary was the loss), so the pair
 * reaches the calculator and the kernel applies its own floor.
 *
 * NB the rate methods answer "vacuously 1" for an empty window — correct for a dashboard tile, wrong here:
 * 0/0 must SUPPRESS, not read as a perfect score. That difference is exactly why these take the counts.
 */
const OPERATIONAL_MEASURE_THRESHOLDS: Readonly<Record<string, ThresholdRule>> = {
  visit_on_time_rate: {
    value: 0.9,
    direction: "gte",
    label: "visit on-time rate (platform default)",
  },
  evv_compliance_rate: {
    value: 0.95,
    direction: "gte",
    label: "EVV compliance rate (platform default; state aggregators commonly require 95%)",
  },
  // LOWER is better — a late entry is a documentation-integrity defect (§8 late-entry tiers).
  late_encounter_entry_rate: {
    value: 0.05,
    direction: "lte",
    label: "late encounter-entry rate (platform default; lower is better)",
  },
  // §2.3 D3 — a verbal order must be signed inside the org's verbal-order deadline (48h floor).
  verbal_order_signature_on_time: {
    value: 0.95,
    direction: "gte",
    label: "verbal-order signature within deadline (platform default)",
  },
  // CoP 418.56(d) — the IDG must review the care plan at least every 15 days.
  care_plan_15_day_adherence: {
    value: 0.95,
    direction: "gte",
    label: "care-plan 15-day review adherence (CoP 418.56(d); platform default)",
  },
  // LOWER is better — a missed scheduled dose is a medication-safety defect.
  missed_dose_rate: {
    value: 0.02,
    direction: "lte",
    label: "missed scheduled-dose rate (platform default; lower is better)",
  },
  // CoP 418.56 — the IDG must meet on its scheduled cadence.
  idg_cadence_adherence: {
    value: 0.95,
    direction: "gte",
    label: "IDG meeting-cadence adherence (CoP 418.56; platform default)",
  },
};

/** The M17 on-time counts read, as this resolver uses it (the registry holds the seam opaquely). */
interface VisitOnTimeCountsView {
  getOnTimeVisitCounts(
    orgId: string,
    windowIso: { from: string; to: string },
  ): Promise<{ numerator: number; denominator: number }>;
}

/** The M8 org-level late-entry tally, as this resolver uses it. */
interface LateEntryCountsView {
  lateEntryCountsForOrg(
    orgId: string,
    window: { from: string; to: string },
  ): Promise<{ numerator: number; denominator: number }>;
}

/** The M11 org-level verbal-order timeliness tally, as this resolver uses it. */
interface VerbalTimelinessCountsView {
  getVerbalTimelinessCountsForOrg(
    orgId: string,
    window: { from: string; to: string },
  ): Promise<{ numerator: number; denominator: number }>;
}

/** The M7 org-level 15-day review-cycle tally, as this resolver uses it. */
interface CarePlanCycleCountsView {
  fifteenDayCycleCountsForOrg(
    orgId: string,
    window: { from: string; to: string },
  ): Promise<{ numerator: number; denominator: number }>;
}

/** The M13 org-level missed-dose tally, as this resolver uses it. */
interface MissedDoseCountsView {
  getMissedDoseCountsForOrg(
    orgId: string,
    window: { from: string; to: string },
  ): Promise<{ numerator: number; denominator: number }>;
}

/** The M14 org-level IDG cadence tally, as this resolver uses it. */
interface IdgCadenceCountsView {
  getCadenceCountsForOrg(
    orgId: string,
    window: { from: string; to: string },
  ): Promise<{ numerator: number; denominator: number }>;
}

/** The M18 compliance counts read, as this resolver uses it. */
interface EvvComplianceCountsView {
  getComplianceCounts(
    orgId: string,
    windowIso: { from: string; to: string },
  ): Promise<{ numerator: number; denominator: number }>;
}

/** The measure codes {@link resolveOperationalMeasureInput} can shape (the routing predicate). */
export const OPERATIONAL_BOUND_MEASURE_CODES = new Set([
  "visit_on_time_rate",
  "evv_compliance_rate",
  "late_encounter_entry_rate",
  "verbal_order_signature_on_time",
  "care_plan_15_day_adherence",
  "missed_dose_rate",
  "idg_cadence_adherence",
]);

/**
 * Shape the live M17/M18 org-level count pairs into their calculator inputs. Aggregate-only — no patient
 * row crosses (D6). A producer whose seam is still the M1 deny-stub throws, and the worker's existing
 * fail-closed handling records the recompute as failed rather than writing a fabricated value.
 */
export async function resolveOperationalMeasureInput(
  request: {
    readonly registration: MeasureRegistration;
    readonly organizationId: string;
    readonly providerEntityId: string;
    readonly periodStart: string;
    readonly periodEnd: string;
  },
  seams: {
    readonly visitMetrics: VisitOnTimeCountsView;
    readonly evvMetrics: EvvComplianceCountsView;
    readonly signedEncounters: LateEntryCountsView;
    readonly orders: VerbalTimelinessCountsView;
    readonly carePlan: CarePlanCycleCountsView;
    readonly administrations: MissedDoseCountsView;
    readonly idg: IdgCadenceCountsView;
  },
): Promise<unknown> {
  const { organizationId, providerEntityId, periodStart, periodEnd } = request;
  const code = request.registration.code;
  const window = { from: periodStart, to: periodEnd };
  const base = { organizationId, providerEntityId, periodStart, periodEnd } as const;
  const threshold = OPERATIONAL_MEASURE_THRESHOLDS[code];
  if (threshold === undefined) {
    return unboundWorkerPort(
      "measureRecompute.data.resolveInput.threshold",
      `no operational threshold default registered for measure '${code}'`,
    );
  }

  switch (code) {
    case "visit_on_time_rate": {
      const c = await seams.visitMetrics.getOnTimeVisitCounts(organizationId, window);
      return { ...base, scheduledVisits: c.denominator, onTimeVisits: c.numerator, threshold };
    }
    case "evv_compliance_rate": {
      const c = await seams.evvMetrics.getComplianceCounts(organizationId, window);
      return { ...base, evvRequiredVisits: c.denominator, evvVerifiedVisits: c.numerator, threshold };
    }
    case "late_encounter_entry_rate": {
      const c = await seams.signedEncounters.lateEntryCountsForOrg(organizationId, window);
      return { ...base, signedEncounters: c.denominator, lateEntries: c.numerator, threshold };
    }
    case "verbal_order_signature_on_time": {
      const c = await seams.orders.getVerbalTimelinessCountsForOrg(organizationId, window);
      return { ...base, totalVerbalOrders: c.denominator, signedOnTime: c.numerator, threshold };
    }
    case "idg_cadence_adherence": {
      const c = await seams.idg.getCadenceCountsForOrg(organizationId, window);
      return {
        ...base,
        requiredMeetingCycles: c.denominator,
        meetingsWithinCadence: c.numerator,
        threshold,
      };
    }
    case "missed_dose_rate": {
      const c = await seams.administrations.getMissedDoseCountsForOrg(organizationId, window);
      return { ...base, scheduledDoses: c.denominator, missedDoses: c.numerator, threshold };
    }
    case "care_plan_15_day_adherence": {
      const c = await seams.carePlan.fifteenDayCycleCountsForOrg(organizationId, window);
      return {
        ...base,
        carePlanCyclesDue: c.denominator,
        cyclesUpdatedWithin15Days: c.numerator,
        threshold,
      };
    }
    default:
      return unboundWorkerPort(
        "measureRecompute.data.resolveInput",
        `'${code}' is not one of the operational measures this resolver shapes`,
      );
  }
}

// ── the HVLDL measure-input resolver (binds `measureRecompute.data.resolveInput` for the 'hvldl' measure) ─

/** The HVLDL last-days-of-life window (§1.1 / §4.11) — three CALENDAR days, the CMS predicate's bound. */
const HVLDL_LAST_DAYS_WINDOW_DAYS = 3;

/** Milliseconds in one calendar day (the `deathAt − N days` lower-bound math the reader scan opens at). */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The federal fiscal year a reporting period falls in (FY starts Oct 1; an Oct–Dec instant belongs to the
 * NEXT calendar year's FY). Derived from `periodEnd` — the period the value reports for — so the qualifying-
 * discipline list tracks the reporting FY (the FY2028 CMS expansion adds chaplain + aide, a constant-only
 * change per D3). Until FY2028 the only registered HVLDL variant is FY2025 (rn + msw).
 */
function federalFiscalYearOf(isoInstant: string): number {
  const d = new Date(isoInstant);
  const month0 = d.getUTCMonth();
  const year = d.getUTCFullYear();
  return month0 >= 9 ? year + 1 : year;
}

/** The HVLDL qualifying-discipline set for the reporting period's FY (rn + msw FY2025; + chaplain/aide FY2028). */
function hvldlQualifyingDisciplinesForPeriod(periodEnd: string): ReadonlySet<string> {
  const disciplines =
    federalFiscalYearOf(periodEnd) >= 2028
      ? HVLDL_QUALIFYING_DISCIPLINES_v2028
      : HVLDL_QUALIFYING_DISCIPLINES_v2025;
  return new Set<string>(disciplines);
}

/**
 * The HVLDL (`hvldl`) measure-input provider (§4.11 / D20) the `m30.measure_recompute` worker reaches when a
 * recompute names the HVLDL code. It builds the decedent census the pure {@link computeHvldl} reduces:
 *
 *   • the DENOMINATOR is EVERY decedent M6's death-discharge census returns for the reporting period (CMS
 *     does not exclude any source — the calculator counts them all);
 *   • each decedent's `qualifyingDisciplineVisitsInLastDays` is the count of M8 signed encounters that are
 *     (a) by a qualifying discipline for the period's FY, (b) on a service date in the last-days window
 *     (service date at-or-before the death date, the reader scan opened `HVLDL_LAST_DAYS_WINDOW_DAYS` days
 *     before death), and (c) EVV-VERIFIED (`evvBracketState === 'evv_present'`) — an EVV-missing-documented
 *     visit does NOT count toward the predicate.
 *
 * The two seams self-scope on their own connections (the M6 reader sets its org GUC itself; the M8 reader is
 * resolved within the worker's tenant context), so each runs one org's census — nothing crosses a tenant
 * boundary. The per-decedent N reads are acceptable for a nightly recompute job.
 *
 * KNOWN LIMITATION (§4.11 external-source breakdown): M6's frozen `discharge_event` models only the death
 * fact — no source / cosign columns — so the reader returns `source='internal_clinician_recorded'` with an
 * undefined cosign status for every decedent. HVLDL still computes correctly (the external subset is empty,
 * so the §4.11 Risk-Register flag never fires); the `source`/`cosignStatus` ride through the contract so the
 * resolver lights up the breakdown once M6 models HL7-external death intake (no change needed here).
 */
export async function resolveHvldlMeasureInput(
  request: {
    readonly registration: MeasureRegistration;
    readonly organizationId: string;
    readonly providerEntityId: string;
    readonly periodStart: string;
    readonly periodEnd: string;
  },
  seams: {
    readonly deathDischargeReader: DeathDischargeReader;
    readonly encounters: SignedEncountersReader;
  },
): Promise<ComputeHvldlInput> {
  const { organizationId, providerEntityId, periodStart, periodEnd } = request;
  const qualifying = hvldlQualifyingDisciplinesForPeriod(periodEnd);

  const deaths = await seams.deathDischargeReader.listDeathDischargesInPeriod(organizationId, {
    from: periodStart,
    to: periodEnd,
  });

  const decedents: HvldlDecedentInput[] = [];
  for (const death of deaths) {
    // The reader scan opens at `deathAt − 3 calendar days`; the upper bound is enforced below by the
    // service-date-at-or-before-death predicate (`serviceDate` is a `yyyy-mm-dd`; the death day is the
    // ISO instant's date prefix — lexical compare is correct for ISO calendar dates).
    const deathDate = death.deathAt.slice(0, 10);
    const since = new Date(
      new Date(death.deathAt).getTime() - HVLDL_LAST_DAYS_WINDOW_DAYS * MS_PER_DAY,
    ).toISOString();

    const digests = await seams.encounters.signedEncountersForPatientSince(
      organizationId,
      death.patientId,
      since,
    );
    const count = digests.filter(
      (e) =>
        qualifying.has(e.discipline) &&
        e.serviceDate <= deathDate &&
        e.evvBracketState === "evv_present",
    ).length;

    decedents.push({
      patientId: death.patientId,
      source: death.source,
      cosignStatus: death.cosignStatus,
      qualifyingDisciplineVisitsInLastDays: count,
    });
  }

  return {
    organizationId,
    providerEntityId,
    periodStart,
    periodEnd,
    decedents,
    nationalAvg: HCI_THRESHOLDS_v2025.hvldlNationalAvg,
    minQualifyingVisits: HVLDL_MIN_QUALIFYING_VISITS,
  };
}

// ── the HCI indicator-10 resolver (visits near death) ──────────────────────────────────────────────────

/**
 * HCI indicator 10 — the proportion of decedents who received a visit in the days immediately before
 * death (higher is better). It resolves from the SAME two live seams the HVLDL path uses: M6's
 * death-discharge census for the denominator, M8's signed-encounter digests for the numerator.
 *
 * It is deliberately NOT the HVLDL predicate. HVLDL additionally requires the visit to be
 * EVV-verified and from a qualifying discipline, and counts visits per decedent against a minimum.
 * HCI-10 asks the looser question — was this decedent visited at all in the window — so the predicate
 * here is "≥1 signed encounter with a service date at or before the death date, inside the window".
 * Sharing the HVLDL discipline/EVV filters would silently make HCI-10 a stricter measure than CMS
 * defines and depress the score.
 *
 * ★ WINDOW (flagged): CMS specifies "the days immediately preceding death" without a single fixed
 *   figure across publications; this uses the same 3-calendar-day window as HVLDL so the two indicators
 *   cannot disagree about which visits were "near death". Revisit when the HCI technical spec pins it.
 *
 * Aggregate-by-default: the loop reads per-decedent digests but returns only two COUNTS (D6).
 */
export async function resolveHciIndicator10Input(
  request: {
    readonly registration: MeasureRegistration;
    readonly organizationId: string;
    readonly providerEntityId: string;
    readonly periodStart: string;
    readonly periodEnd: string;
  },
  seams: {
    readonly deathDischargeReader: DeathDischargeReader;
    readonly encounters: SignedEncountersReader;
  },
): Promise<unknown> {
  const { organizationId, providerEntityId, periodStart, periodEnd } = request;

  const deaths = await seams.deathDischargeReader.listDeathDischargesInPeriod(organizationId, {
    from: periodStart,
    to: periodEnd,
  });

  let decedentsWithNearDeathVisits = 0;
  for (const death of deaths) {
    const deathDate = death.deathAt.slice(0, 10);
    const since = new Date(
      new Date(death.deathAt).getTime() - HVLDL_LAST_DAYS_WINDOW_DAYS * MS_PER_DAY,
    ).toISOString();
    const digests = await seams.encounters.signedEncountersForPatientSince(
      organizationId,
      death.patientId,
      since,
    );
    if (digests.some((e) => e.serviceDate <= deathDate)) decedentsWithNearDeathVisits += 1;
  }

  return {
    organizationId,
    providerEntityId,
    periodStart,
    periodEnd,
    // EVERY decedent in the period is the denominator — a decedent with no visits at all must stay in
    // the population, since "was never visited before death" is exactly what this indicator measures.
    totalDecedents: deaths.length,
    decedentsWithNearDeathVisits,
    threshold: HCI_THRESHOLDS_v2025.indicators.indicator_10,
  };
}

// ── the per-queue port bundles (bind what we can; throw-on-call for the genuinely-missing infra) ────────

/** The bound port bundles `registerM30Workers` drives the four §4.8 work-queue processors with. */
export interface M30WorkerPortBundles {
  readonly measureRecompute: MeasureRecomputePorts;
  readonly cahpsExport: CahpsExportPorts;
  readonly outbreakDetection: OutbreakDetectionPorts;
  readonly riskRegisterRefresh: RiskRegisterRefreshPorts;
}

/** The bound port bundles `registerM30CronWorkers` drives the four §4.8 cron processors with. */
export interface M30CronPortBundles {
  readonly nightlyRecompute: NightlyRecomputeCronPorts;
  readonly cahpsMonthlySample: CahpsMonthlySampleCronPorts;
  readonly riskRegisterRefresh: RiskRegisterRefreshCronPorts;
  readonly sraReminders: SraRemindersCronPorts;
}

/**
 * Build every §4.8 WORK-queue processor's port bundle from {@link M30WorkerDeps}. Pure assembly — no
 * `Worker`/`Queue` here, so the binding is unit-inspectable. The BINDABLE ports (the M30 repos + the
 * PRIMARY-pool REFRESH reached through `db.execute(sql\`…\`)` + the LIVE M10 HOPE consumer + the per-org
 * CAHPS adapter resolver) are wired to real adapters; the still-missing cross-module infra ports carry a
 * LAZY typed `M30WorkerPortUnbound` throw + a TODO naming the integrator's seam.
 *
 * NB: the per-job tenancy envelope (`withOrgContext(orgId)` per {@link M30_QUEUE_SCOPE} — every §4.8 work
 * queue is ORG-scoped) is applied by the WORKER closure / the integrator; the repos issue plain Drizzle
 * inside whichever transaction the envelope opens. Here we hand the repos the base client (mechanism-vs-
 * policy: the worker owns the RLS envelope — the M33 precedent).
 */
export function buildM30WorkerPorts(deps: M30WorkerDeps): M30WorkerPortBundles {
  const now = deps.now ?? (() => new Date());
  const db = deps.db;
  const primaryDb = deps.primaryDb ?? deps.db;

  const measureValueRepo = new QualityMeasureValueRepository(db); // quality_measure_value (append-only ledger)
  const recomputeQueueRepo = new MeasureRecomputeQueueRepository(db); // measure_recompute_queue (debounce)
  const cahpsRepo = new CahpsRepository(db); // cahps_vendor_binding + cahps_decedent_sample + result_summary
  const infectionRepo = new InfectionRepository(db); // infection_surveillance_event + infection_outbreak_case
  const riskRepo = new RiskRegisterRepository(db); // the four risk-register source tables (D13)

  const processingLog: ProcessingLogPort = deps.processingLog ?? {
    isProcessed: () =>
      unboundWorkerPort(
        "processingLog.isProcessed",
        "bind to the M1-owned `processing_log` consumer-idempotency table accessor (§4.8 replay guard)",
      ),
    markProcessed: () =>
      unboundWorkerPort("processingLog.markProcessed", "bind to the M1-owned `processing_log` table accessor"),
  };

  // ── HVLDL measure-input seams (M6 death census + M8 signed encounters) — fail-closed thunk until bound ──
  // The composition root resolves both via `getSeam`. Each self-scopes on its own connection, so they ride
  // through the per-job port rebuild unchanged. Absent ⇒ a LAZY throw so an HVLDL recompute denies on RUN
  // (never at port-bundle construction — the M34 eager-bind gotcha); other measure codes never touch them.
  const deathDischargeReader: DeathDischargeReader = deps.deathDischargeReader ?? {
    listDeathDischargesInPeriod: () =>
      unboundWorkerPort(
        "measureRecompute.hvldl.deathDischargeReader",
        "bind the M6 DeathDischargeReader (the HVLDL death-discharge denominator census) via getSeam at the composition root",
      ),
  };
  const signedEncounters: SignedEncountersReader = deps.signedEncounters ?? {
    signedEncountersForPatientSince: () =>
      unboundWorkerPort(
        "measureRecompute.hvldl.signedEncounters.signedEncountersForPatientSince",
        "bind the M8 SignedEncountersReader (the EVV-verified qualifying-visit source for HVLDL) via getSeam",
      ),
    renderPayloadFor: () =>
      unboundWorkerPort(
        "measureRecompute.hvldl.signedEncounters.renderPayloadFor",
        "the HVLDL resolver only calls signedEncountersForPatientSince; renderPayloadFor is unused on this path",
      ),
    lateEntryCountsForOrg: () =>
      unboundWorkerPort(
        "measureRecompute.lateEntry.signedEncounters.lateEntryCountsForOrg",
        "bind the M8 SignedEncountersReader (the org-level late-entry tally) via getSeam at the composition root",
      ),
  };

  // ── m30.measure_recompute (withOrgContext) — §7.1 / V-8 ────────────────────────────────────────────────
  // BOUND: the `quality_measure_value` store + the debounce-queue drain + the LIVE M10 HOPE consumer + the
  // V-5 snapshot hash + id mint. UNBOUND (lazy): the per-family measure-input provider (no stable accessor —
  // the composition root must shape each measure's input) and the two §4.10 outbox emits (RULE 3a).
  const measureRecompute: MeasureRecomputePorts = {
    processingLog,
    // The platform measure registry, keyed by code — every catalog descriptor bound to its concrete pure
    // calculator (`buildMeasureRegistry()`; the HCI ten indicators + composite, HVLDL, the two HOPE-derived,
    // the fifteen operational measures). The composition root may still override via `deps.registrations`;
    // the default is the FULL registry so a recompute resolves a calculator by code (V-8) rather than the
    // old empty map that failed every job closed with `MeasureRegistrationMissing`. The per-family
    // measure-input provider (`data.resolveInput`) stays the integrator's remaining lazy-unbound seam.
    registrations: deps.registrations ?? buildMeasureRegistry(),
    hope: deps.hope, // LIVE — the one consumed seam (§4.4 / M10-real)
    data: {
      // BOUND (HOPE-family): the four HOPE measures (tfp_pi / tfp_npsi / hope_sfv_on_time_rate /
      // hope_submission_acceptance_rate) shape the live M10 org-rollup COUNTS into their calculator input
      // (see {@link resolveHopeMeasureInput}). BOUND (HVLDL): the `hvldl` measure shapes the M6 death census
      // × M8 EVV-verified qualifying visits into the decedent census (see {@link resolveHvldlMeasureInput}) —
      // its two seams are closed over from `deps` (the worker's `{ hope }` seam arg carries only the HOPE
      // consumer). Any OTHER measure code stays fail-closed — the remaining families' M5–M18 read seams are
      // the integrator's remaining lazy-unbound shaping work.
      resolveInput: (request, seams) => {
        if (request.registration.code === "hci_indicator_10")
          return resolveHciIndicator10Input(request, {
            deathDischargeReader,
            encounters: signedEncounters,
          });
        if (request.registration.code === "hvldl")
          return resolveHvldlMeasureInput(request, {
            deathDischargeReader,
            encounters: signedEncounters,
          });
        // BOUND (operational): the two measures whose producers tally ORG-LEVEL counts. M17/M18 now expose
        // the count PAIR beside their rate methods, so the CMS small-N floor can be applied honestly.
        if (OPERATIONAL_BOUND_MEASURE_CODES.has(request.registration.code))
          return resolveOperationalMeasureInput(request, {
            visitMetrics: getSeam("VisitMetricsProvider") as never,
            evvMetrics: getSeam("EvvMetricsProvider") as never,
            // The same M8 reader the HVLDL path uses — closed over from deps so an unbound boot throws
            // lazily on RUN rather than at port-bundle construction.
            signedEncounters,
            orders: getSeam("OrderProvider") as never,
            carePlan: getSeam("CarePlanReader") as never,
            administrations: getSeam("MedicationAdministrationProvider") as never,
            idg: getSeam("IdgScheduleProvider") as never,
          });
        return resolveHopeMeasureInput(request, seams);
      },
    },
    values: {
      findCurrent: (measureCode, providerEntityId, periodStart, periodEnd) =>
        measureValueRepo.findCurrent(measureCode, providerEntityId, periodStart, periodEnd),
      insertValue: (values) => measureValueRepo.insertValue(values),
      async supersede(id, supersededBy, supersededAt) {
        await measureValueRepo.supersede(id, supersededBy, supersededAt);
      },
    },
    recomputeQueue: {
      findPending: (measureCode, providerEntityId, periodStart, periodEnd) =>
        recomputeQueueRepo.findPending(measureCode, providerEntityId, periodStart, periodEnd),
      async markProcessed(id, processedAt) {
        await recomputeQueueRepo.markProcessed(id, processedAt);
      },
    },
    outbox: {
      emitValueEmitted: () =>
        unboundWorkerPort(
          "measureRecompute.outbox.emitValueEmitted",
          "bind to the live transactional-outbox dispatcher (m30.measure.value_emitted → M28 FHIR / M33 dashboard)",
        ),
      emitThresholdBreached: () =>
        unboundWorkerPort(
          "measureRecompute.outbox.emitThresholdBreached",
          "bind to the live transactional-outbox dispatcher (m30.qapi.indicator_threshold_breached → M36)",
        ),
    },
    hashSnapshot: (snapshot) => hashSnapshot(snapshot),
    newValueId: () => randomUUID(),
    now,
  };

  // ── m30.cahps_export (withOrgContext) — §7.2 / W-14 ────────────────────────────────────────────────────
  // BOUND: the per-org adapter resolver + the `cahps_decedent_sample` store (list pending / mark exported /
  // mark failed). UNBOUND (lazy): the PHI envelope-DEK decrypt + the vendor-config decrypt (RULE 3b — fail
  // closed; every run reaches the §4.8 terminal export_failed on its final attempt) and the §4.10 emits.
  const cahpsExport: CahpsExportPorts = {
    processingLog,
    adapters: deps.cahpsAdapters ?? {
      resolve: () =>
        unboundWorkerPort(
          "cahpsExport.adapters.resolve",
          "bind to the per-org `CahpsAdapterRegistry` seeded from @wardenx/cahps-vendors (org boot / R-11 rotation)",
        ),
    },
    samples: {
      listPendingForCycle: (orgId, samplingCycleMonth) =>
        cahpsRepo.listSamplesForCycle(orgId, samplingCycleMonth, "pending_export"),
      async markExported(id, samplingCycleMonth, patch) {
        await cahpsRepo.updateSampleExportStatus(id, samplingCycleMonth, {
          status: "exported_to_vendor",
          exportedAt: patch.exportedAt,
          vendorAckRef: patch.vendorAckRef,
        });
      },
      async markExportFailed(id, samplingCycleMonth) {
        await cahpsRepo.updateSampleExportStatus(id, samplingCycleMonth, { status: "export_failed" });
      },
    },
    decrypt: {
      // ★ FAIL-CLOSED: until the M1 envelope-DEK helper is bound, a sample row's caregiver contact is never
      //   decrypted — the export denies rather than forwarding un-decrypted PHI (§8 / the M33 precedent).
      toVendorRow: () =>
        unboundWorkerPort(
          "cahpsExport.decrypt.toVendorRow",
          "bind to the M1 per-tenant envelope-DEK decrypt for `primary_caregiver_contact_cipher` — export denies until bound",
        ),
    },
    bindingConfig: {
      load: () =>
        unboundWorkerPort(
          "cahpsExport.bindingConfig.load",
          "bind to the M1 envelope-DEK decrypt for `cahps_vendor_binding.configuration_cipher` (pushExport config)",
        ),
    },
    outbox: {
      emitExportCompleted: () =>
        unboundWorkerPort(
          "cahpsExport.outbox.emitExportCompleted",
          "bind to the live transactional-outbox dispatcher (m30.cahps.export_completed)",
        ),
      emitExportFailed: () =>
        unboundWorkerPort(
          "cahpsExport.outbox.emitExportFailed",
          "bind to the live transactional-outbox dispatcher (m30.cahps.export_failed → M36)",
        ),
    },
    now,
  };

  // ── m30.outbreak_detection (withOrgContext, serial per org) — §7.8 / D11 / V-18 ────────────────────────
  // BOUND: the outbreak-case dedupe/create (the `uq_outbreak_window` oracle). UNBOUND (lazy): the trailing-
  // window org event read (no repo method spans the whole org window yet) and the §4.10 outbreak emit.
  const outbreakDetection: OutbreakDetectionPorts = {
    processingLog,
    events: {
      recentForOrg: () =>
        unboundWorkerPort(
          "outbreakDetection.events.recentForOrg",
          "bind to an `InfectionRepository` org-wide trailing-window read (observed_at ≥ now−windowDays) — the repo exposes per-(provider,pathogen,body_site) windows + org keyset paging, not this org-wide scan yet",
        ),
    },
    cases: {
      findByWindow: (providerEntityId, pathogen, bodySite, windowStart, windowEnd) =>
        infectionRepo.findOutbreakByWindow(providerEntityId, pathogen, bodySite, windowStart, windowEnd),
      create: (values) => infectionRepo.createOutbreak(values),
    },
    outbox: {
      emitOutbreakOpened: () =>
        unboundWorkerPort(
          "outbreakDetection.outbox.emitOutbreakOpened",
          "bind to the live transactional-outbox dispatcher (m30.infection.outbreak_opened → M36 high alert)",
        ),
    },
  };

  // ── m30.risk_register_refresh (withOrgContext, serial per org) — §7.9 / D13 / WF-20 ────────────────────
  // BOUND: the PRIMARY-pool `REFRESH MATERIALIZED VIEW CONCURRENTLY` + the four-source projection loader.
  // UNBOUND (lazy): the §4.10 refreshed emit.
  const riskRegisterRefresh: RiskRegisterRefreshPorts = {
    processingLog,
    refresh: {
      // D3/D13 — the one write path: REFRESH on the PRIMARY (CONCURRENTLY keeps R-95 reads live). The MV is
      // migration-owned + platform-global; the per-org serialization is the queue's concern, not the SQL's.
      async refreshConcurrently(_orgId) {
        await primaryDb.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY risk_register_view`);
      },
    },
    sources: {
      loadOpenRiskSources: (orgId) => riskRepo.loadOpenRiskSources(orgId),
    },
    outbox: {
      emitRefreshed: () =>
        unboundWorkerPort(
          "riskRegisterRefresh.outbox.emitRefreshed",
          "bind to the live transactional-outbox dispatcher (m30.risk_register.refreshed → M33 unified-risk view)",
        ),
    },
    now,
  };

  return { measureRecompute, cahpsExport, outbreakDetection, riskRegisterRefresh };
}

/**
 * Build every §4.8 CRON processor's port bundle from {@link M30WorkerDeps}. All four crons run a PLATFORM-
 * scoped enumeration of active orgs, then fan ORG-scoped jobs out onto the §4.8 work queues (or, for the SRA
 * reminders, dispatch the §4.9 M36 alert). BOUND: the read-only CAHPS active-vendor-binding probe. UNBOUND
 * (lazy): the platform active-org enumerator (no boot accessor here — supplied by the integrator over the M2
 * org reader under `withPlatformContext`), the per-org recompute/refresh ENQUEUE producers (the BullMQ
 * `Queue.add` fan-out — bound by the integrator over `buildM30RecomputeEnqueue`, never constructed here so
 * this stays `Queue`-free), the death-feed decedent reader + the PHI sample WRITE (RULE 3b — DEK), the
 * platform open-SRA-cycle scan, and the §4.9 SRA alert dispatch (RULE 3e — the M36 router).
 */
export function buildM30CronPorts(deps: M30WorkerDeps): M30CronPortBundles {
  const now = deps.now ?? (() => new Date());
  const cahpsRepo = new CahpsRepository(deps.db);

  const orgs: ActiveOrgListPort = deps.activeOrgs ?? {
    listActiveOrgs: () =>
      unboundWorkerPort(
        "cron.orgs.listActiveOrgs",
        "bind to the M2 active-org enumerator under `withPlatformContext` (the cron fan-out source)",
      ),
  };

  // ── m30.nightly_recompute (03:15 daily) — §7.1 / WF-01 ─────────────────────────────────────────────────
  const nightlyRecompute: NightlyRecomputeCronPorts = {
    orgs,
    enqueue: {
      enqueueForOrg: () =>
        unboundWorkerPort(
          "nightlyRecompute.enqueue.enqueueForOrg",
          "bind to the per-org recompute fan-out (M40 provider list × active measure catalog × resolved periods → `m30.measure_recompute` `Queue.add` via buildM30RecomputeEnqueue)",
        ),
    },
    now,
  };

  // ── m30.cahps_monthly_sample (02:00 day-2 of month) — §7.2 / WF-04 ─────────────────────────────────────
  const cahpsMonthlySample: CahpsMonthlySampleCronPorts = {
    orgs,
    candidates: {
      listPriorMonthDecedents: () =>
        unboundWorkerPort(
          "cahpsMonthlySample.candidates.listPriorMonthDecedents",
          "bind to the M5/M6 prior-month death-feed reader (the decedent candidates the CMS sampler classifies)",
        ),
    },
    samples: {
      async activeVendorBinding(orgId) {
        const binding = await cahpsRepo.findActiveBinding(orgId);
        return binding === null
          ? null
          : { vendorBindingId: binding.id, vendor: binding.vendorAdapterId };
      },
      // ★ FAIL-CLOSED: the sampled-row INSERT envelope-encrypts the caregiver contact (PHI) → needs the M1
      //   DEK helper; until bound the write denies rather than persisting plaintext (the M33 precedent).
      insertSampled: () =>
        unboundWorkerPort(
          "cahpsMonthlySample.samples.insertSampled",
          "bind to the `cahps_decedent_sample` insert WITH the M1 envelope-DEK encrypt of `primary_caregiver_contact_cipher`",
        ),
    },
    outbox: {
      emitSampleReady: () =>
        unboundWorkerPort(
          "cahpsMonthlySample.outbox.emitSampleReady",
          "bind to the live transactional-outbox dispatcher (m30.cahps.sample_ready → M36 info)",
        ),
    },
    now,
  };

  // ── m30.risk_register_refresh (04:00 daily) — §7.9 ─────────────────────────────────────────────────────
  const riskRegisterRefresh: RiskRegisterRefreshCronPorts = {
    orgs,
    enqueue: {
      enqueueRefresh: () =>
        unboundWorkerPort(
          "riskRegisterRefreshCron.enqueue.enqueueRefresh",
          "bind to the force-refresh `Queue.add` onto `m30.risk_register_refresh` (jobId `(orgId, dateBucket)`) via buildM30RecomputeEnqueue",
        ),
    },
    now,
  };

  // ── m30.sra_reminders (09:00 daily) — §4.9 / W-M30-30 ──────────────────────────────────────────────────
  const sraReminders: SraRemindersCronPorts = {
    cycles: {
      listOpenCyclesWithDue: () =>
        unboundWorkerPort(
          "sraReminders.cycles.listOpenCyclesWithDue",
          "bind to the platform-scoped open-SRA-cycle scan (`sra_cycle` un-closed rows + `due_at`, under `withPlatformContext`)",
        ),
    },
    alerts: {
      // RULE 3e — alerts ship as defs + fire through the outbox; the live M36 router is the consumer.
      dispatch: () =>
        unboundWorkerPort(
          "sraReminders.alerts.dispatch",
          "bind to the live M36 alert router / transactional-outbox (the §4.9 sra_due_*/sra_overdue payloads)",
        ),
    },
    now,
  };

  return { nightlyRecompute, cahpsMonthlySample, riskRegisterRefresh, sraReminders };
}

// ── the four §4.8 cron queue names (the cron CONSUMERS' wire names) ──────────────────────────────────────

/**
 * The dedicated BullMQ queue names the four §4.8 cron repeatables enqueue onto + the cron workers consume.
 * Distinct from the {@link M30_QUEUES} WORK queues (the crons fan ORG-scoped jobs OUT onto those). The risk
 * cron carries a `.cron` discriminator so it does NOT collide with the `m30.risk_register_refresh` WORK
 * queue (a shared Redis queue name would deliver the empty cron tick to the per-org refresh worker).
 */
export const M30_CRON_QUEUES = {
  nightlyRecompute: "m30.nightly_recompute",
  cahpsMonthlySample: "m30.cahps_monthly_sample",
  riskRegisterRefresh: "m30.risk_register_refresh.cron",
  sraReminders: "m30.sra_reminders",
} as const;

export type M30CronQueueName = (typeof M30_CRON_QUEUES)[keyof typeof M30_CRON_QUEUES];

// ── live worker construction (the M33 m33-jobs.ts template) ──────────────────────────────────────────────

/**
 * Construct one BullMQ `Worker` per §4.8 WORK queue (measure_recompute / cahps_export / outbreak_detection /
 * risk_register_refresh), each driving the matching pure processor with the bound ports. Returns the workers
 * so the composition root can `close()` them on shutdown — the caller owns the lifecycle; nothing here runs
 * at import (constructing a Worker opens the Valkey connection, which must happen only in production wiring,
 * never in tests).
 *
 * The per-job tenancy envelope (`withOrgContext(orgId)` per {@link M30_QUEUE_SCOPE} — every §4.8 work queue
 * is ORG-scoped) is the SEPARATE integration concern: the ports built above expect to be invoked inside that
 * envelope, so the integrator either wraps the processor body or threads a per-job scoped DB handle. This
 * function constructs the worker shells; binding the envelope + supplying the still-missing infra seams is
 * the integrator's remaining step (the typed throws above name each missing seam).
 */
/**
 * The actor id a §4.8 worker's `withOrgContext` envelope carries — the empty-string system sentinel the M4
 * write-audit trigger maps to a NULL actor (it NULLIFs the empty user-id GUC). A background recompute has no
 * acting user, so its quality_measure_value writes audit with a null actor.
 */
const M30_WORKER_SYSTEM_USER_ID = "";

export function registerM30Workers(deps: M30WorkerDeps): Worker[] {
  const ports = buildM30WorkerPorts(deps);
  const { connection } = deps;
  const mk = <D, R>(
    queue: string,
    processor: (data: D) => Promise<R>,
    concurrency: number,
  ): Worker => new Worker(queue, async (job) => processor(job.data as D), { connection, concurrency });

  // #107 item 4a — measure_recompute WRITES quality_measure_value (RLS `WITH CHECK app.org_id`) and its
  // resolveInput reads the M10 HOPE rollups, so the job MUST run inside a per-job `withOrgContext` envelope:
  // we open it on the org from the job payload and REBUILD the value-store / queue-drain ports over that tx so
  // the insert + soft-supersede + debounce-drain all carry `app.org_id` (without it the RLS WITH CHECK denies
  // the insert). The HOPE seam (`deps.hope`) self-scopes on its own connection (the M10 org-rollup store opens
  // its own withOrgContext). `userId` is the system sentinel '' — the M4 write-audit trigger NULLIFs it (a
  // system recompute has no acting user). outbreak_detection is wrapped the SAME way below (it WRITES
  // infection_outbreak_case under the RLS WITH CHECK). The other two work queues keep the base client:
  // risk_register_refresh runs `REFRESH MATERIALIZED VIEW CONCURRENTLY` (illegal inside a tx), and cahps_export
  // performs vendor I/O (adapter render/push) that must not sit inside an open tx — a separate split is a
  // follow-up (#107).
  const measureRecomputeWorker = new Worker(
    M30_QUEUES.measureRecompute,
    async (job) => {
      const data = job.data as MeasureRecomputeJob;
      return withOrgContext(
        deps.db,
        { organizationId: data.organizationId, userId: M30_WORKER_SYSTEM_USER_ID },
        (tx) =>
          measureRecomputeProcessor(
            buildM30WorkerPorts({ ...deps, db: tx as unknown as DbClient }).measureRecompute,
          )(data),
      );
    },
    { connection, concurrency: M30_QUEUE_PARAMS.measureRecompute.concurrency },
  );

  // #107 — outbreak_detection inserts infection_outbreak_case (RLS WITH CHECK app.org_id) + clusters from the
  // org's surveillance events: same per-job withOrgContext envelope as measure_recompute (pure DB, tx-safe).
  const outbreakDetectionWorker = new Worker(
    M30_QUEUES.outbreakDetection,
    async (job) => {
      const data = job.data as OutbreakDetectionJob;
      return withOrgContext(
        deps.db,
        { organizationId: data.organizationId, userId: M30_WORKER_SYSTEM_USER_ID },
        (tx) =>
          outbreakDetectionProcessor(
            buildM30WorkerPorts({ ...deps, db: tx as unknown as DbClient }).outbreakDetection,
          )(data),
      );
    },
    { connection, concurrency: M30_QUEUE_PARAMS.outbreakDetection.concurrency },
  );

  return [
    measureRecomputeWorker,
    outbreakDetectionWorker,
    mk(
      M30_QUEUES.cahpsExport,
      cahpsExportProcessor(ports.cahpsExport),
      M30_QUEUE_PARAMS.cahpsExport.concurrency,
    ),
    mk(
      M30_QUEUES.riskRegisterRefresh,
      riskRegisterRefreshProcessor(ports.riskRegisterRefresh),
      M30_QUEUE_PARAMS.riskRegisterRefresh.concurrency,
    ),
  ];
}

/**
 * Construct one BullMQ `Worker` per §4.8 CRON queue ({@link M30_CRON_QUEUES}), each driving the matching pure
 * cron processor (the cron tick carries no payload — the processor reads its own ports). Unlike the M33
 * crons (which fed worker-backed WORK queues), M30 has four STANDALONE crons that fan out, so each needs its
 * own consumer; this builds them. Concurrency 1 — a cron tick is a singleton. Returns the workers; the caller
 * owns `close()`. Mirrors `registerM30Workers` (the same `new Worker(queue, processor, { connection })`
 * template); nothing runs at import.
 */
export function registerM30CronWorkers(deps: M30WorkerDeps): Worker[] {
  const ports = buildM30CronPorts(deps);
  const { connection } = deps;
  const mk = (queue: string, processor: () => Promise<unknown>): Worker =>
    new Worker(queue, async () => processor(), { connection, concurrency: 1 });

  return [
    mk(M30_CRON_QUEUES.nightlyRecompute, nightlyRecomputeCronProcessor(ports.nightlyRecompute)),
    mk(M30_CRON_QUEUES.cahpsMonthlySample, cahpsMonthlySampleCronProcessor(ports.cahpsMonthlySample)),
    mk(M30_CRON_QUEUES.riskRegisterRefresh, riskRegisterRefreshCronProcessor(ports.riskRegisterRefresh)),
    mk(M30_CRON_QUEUES.sraReminders, sraRemindersCronProcessor(ports.sraReminders)),
  ];
}

/**
 * Register the four §4.8 repeatable cron schedules ({@link M30_JOB_SCHEDULES}) on their dedicated
 * {@link M30_CRON_QUEUES} — the nightly full-org recompute (03:15), the monthly decedent sample (02:00 day-2),
 * the daily risk-register force-refresh (04:00), and the daily SRA reminder-calendar scan (09:00), all UTC.
 * Returns the schedule `Queue`s so the composition root can `close()` them. Mirrors `scheduleM33Jobs` (the
 * repeatable-registration template): one `Queue` per cron, `add('scheduled', {}, { repeat: { pattern } })`.
 * Each tick is consumed by the matching `registerM30CronWorkers` worker. Nothing runs at import.
 */
export async function scheduleM30Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const schedules: readonly [M30CronQueueName, string][] = [
    [M30_CRON_QUEUES.nightlyRecompute, M30_JOB_SCHEDULES.nightlyRecompute],
    [M30_CRON_QUEUES.cahpsMonthlySample, M30_JOB_SCHEDULES.cahpsMonthlySample],
    [M30_CRON_QUEUES.riskRegisterRefresh, M30_JOB_SCHEDULES.riskRegisterRefresh],
    [M30_CRON_QUEUES.sraReminders, M30_JOB_SCHEDULES.sraReminders],
  ];
  const queues: Queue[] = [];
  for (const [name, pattern] of schedules) {
    const queue = new Queue(name, { connection });
    await queue.add("scheduled", {}, { repeat: { pattern }, removeOnComplete: true });
    queues.push(queue);
  }
  return queues;
}

/** Build the {@link M30WorkerDeps} from the composition-root primitives (the M33 `buildM33WorkerDeps` shape).
 *  `hopeProvider` is the LIVE M10 consumer the integrator resolves via `getSeam` (the one consumed seam). */
export function buildM30WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  hopeProvider: QualityHopeConsumer;
  primaryDb?: DbClient;
  cahpsAdapters?: CahpsAdapterResolvePort;
  processingLog?: ProcessingLogPort;
  activeOrgs?: ActiveOrgListPort;
  registrations?: ReadonlyMap<string, MeasureRegistration>;
  /** The M6 HVLDL death-census reader + the M8 signed-encounter reader (resolved via `getSeam`). */
  deathDischargeReader?: DeathDischargeReader;
  signedEncounters?: SignedEncountersReader;
}): M30WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    primaryDb: deps.primaryDb,
    hope: deps.hopeProvider,
    cahpsAdapters: deps.cahpsAdapters,
    processingLog: deps.processingLog,
    activeOrgs: deps.activeOrgs,
    deathDischargeReader: deps.deathDischargeReader,
    signedEncounters: deps.signedEncounters,
    // Default to the FULL catalog→calculator registry (the integrator may still override). With this the
    // measure-recompute worker resolves a calculator by measure code instead of failing closed on an empty map.
    registrations: deps.registrations ?? buildMeasureRegistry(),
    now: () => new Date(),
  };
}

// TODO(integrator — the still-missing infra seams the typed throws above name):
//   • the live transactional-outbox dispatcher accessor (every `emit*` / cron `outbox` port) — bind it and
//     the measure-value / cahps-export / outbreak / risk-refresh / sample-ready emits light up.
//   • the M1 envelope-DEK helper (the CAHPS `decrypt` / `bindingConfig` ports + the cron `insertSampled`) —
//     until bound, CAHPS export denies (terminal export_failed) and the monthly sample write denies; register
//     it in bootstrap/seams so the DEK resolves (never plaintext caregiver PHI at rest, §3.6/§8).
//   • the live M36 alert router (the SRA-reminders `alerts.dispatch`, RULE 3e) — alerts ship as defs + fire
//     through the outbox; M36 is the consumer.
//   • the per-family measure-input provider (`measureRecompute.data.resolveInput`) — the HOPE-derived four +
//     HVLDL are now bound; shape the REMAINING measures' calculator input from the M5–M18 read seams, and
//     pass the measure registry (`deps.registrations`, each catalog descriptor bound to its pure calculator).
//   • the HVLDL seams (`deps.deathDischargeReader` = M6 DeathDischargeReader; `deps.signedEncounters` = M8
//     SignedEncountersReader) — bind both via `getSeam` at boot so the HVLDL recompute resolves its census
//     (each self-scopes on its own connection); until then an `hvldl` recompute denies fail-closed on run.
//   • the M2 platform active-org enumerator (`cron.orgs`), the death-feed decedent reader (cahps candidates),
//     and the platform open-SRA-cycle scan (`sraReminders.cycles`) under `withPlatformContext`.
//   • the per-org recompute/refresh ENQUEUE producers (`nightlyRecompute.enqueue` / `riskRegisterRefreshCron
//     .enqueue`) — bind over `buildM30RecomputeEnqueue` (wiring.ts) so the crons fan `Queue.add` jobs out.
//   • the M1-owned `processing_log` table accessor (`deps.processingLog`) — bindable, not platform-deferred.
//   • the dedicated primary pool (`deps.primaryDb`) for the risk-register MV REFRESH + registering the M30
//     cron jobIds in the @wardenx/tenancy PLATFORM_CONTEXT_ALLOWLIST so the platform-scoped scans are admitted.
//   • wrap each WORK processor body (or thread a per-job scoped DB handle) in `withOrgContext(orgId)` per
//     M30_QUEUE_SCOPE (F09) before mounting — `registerM30Workers` builds the shells.

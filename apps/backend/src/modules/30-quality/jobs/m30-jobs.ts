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
import {
  type ActiveOrgListPort,
  type CahpsExportPorts,
  type CahpsMonthlySampleCronPorts,
  CahpsRepository,
  type HopeSfvOnTimeRateInput,
  type HopeSubmissionAcceptanceRateInput,
  type MeasureRecomputePorts,
  type MeasureRegistration,
  InfectionRepository,
  type NightlyRecomputeCronPorts,
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
import type { HopeRollupPeriod } from "@wardenx/types";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";

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
      // (see {@link resolveHopeMeasureInput}). Any OTHER measure code stays fail-closed — the non-HOPE
      // families' M5–M18 read seams are the integrator's remaining lazy-unbound shaping work.
      resolveInput: (request, seams) => resolveHopeMeasureInput(request, seams),
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
export function registerM30Workers(deps: M30WorkerDeps): Worker[] {
  const ports = buildM30WorkerPorts(deps);
  const { connection } = deps;
  const mk = <D, R>(
    queue: string,
    processor: (data: D) => Promise<R>,
    concurrency: number,
  ): Worker => new Worker(queue, async (job) => processor(job.data as D), { connection, concurrency });

  return [
    mk(
      M30_QUEUES.measureRecompute,
      measureRecomputeProcessor(ports.measureRecompute),
      M30_QUEUE_PARAMS.measureRecompute.concurrency,
    ),
    mk(
      M30_QUEUES.cahpsExport,
      cahpsExportProcessor(ports.cahpsExport),
      M30_QUEUE_PARAMS.cahpsExport.concurrency,
    ),
    mk(
      M30_QUEUES.outbreakDetection,
      outbreakDetectionProcessor(ports.outbreakDetection),
      M30_QUEUE_PARAMS.outbreakDetection.concurrency,
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
}): M30WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    primaryDb: deps.primaryDb,
    hope: deps.hopeProvider,
    cahpsAdapters: deps.cahpsAdapters,
    processingLog: deps.processingLog,
    activeOrgs: deps.activeOrgs,
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
//   • the per-family measure-input provider (`measureRecompute.data.resolveInput`) — shape each measure's
//     calculator input from the M5–M18 read seams + the live M10 HOPE rollups, and pass the measure
//     registry (`deps.registrations`, each catalog descriptor bound to its concrete pure calculator).
//   • the M2 platform active-org enumerator (`cron.orgs`), the death-feed decedent reader (cahps candidates),
//     and the platform open-SRA-cycle scan (`sraReminders.cycles`) under `withPlatformContext`.
//   • the per-org recompute/refresh ENQUEUE producers (`nightlyRecompute.enqueue` / `riskRegisterRefreshCron
//     .enqueue`) — bind over `buildM30RecomputeEnqueue` (wiring.ts) so the crons fan `Queue.add` jobs out.
//   • the M1-owned `processing_log` table accessor (`deps.processingLog`) — bindable, not platform-deferred.
//   • the dedicated primary pool (`deps.primaryDb`) for the risk-register MV REFRESH + registering the M30
//     cron jobIds in the @wardenx/tenancy PLATFORM_CONTEXT_ALLOWLIST so the platform-scoped scans are admitted.
//   • wrap each WORK processor body (or thread a per-job scoped DB handle) in `withOrgContext(orgId)` per
//     M30_QUEUE_SCOPE (F09) before mounting — `registerM30Workers` builds the shells.

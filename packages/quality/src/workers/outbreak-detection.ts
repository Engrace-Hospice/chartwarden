// @wardenx/quality · workers — the `m30.outbreak_detection` PURE processor (§4.8 / §7.8 / D11 WF-18).
//
// The body the `m30.outbreak_detection` worker runs per recorded surveillance event (serialized per org,
// concurrency 1): re-run the ≥3-events/14d cluster detector over the org's recent events and open an
// `infection_outbreak_case` for any newly-qualifying cluster. It opens with the §4.8 `processing_log`
// guard, fetches the trailing-window events, runs the PURE {@link detectOutbreakClusters}, and for each
// detected cluster dedupes against the live `uq_outbreak_window` (provider, pathogen, body_site, window)
// before inserting + emitting `m30.infection.outbreak_opened`. An existing window is an idempotent skip —
// outbreak cases are server-derived and never double-opened (V-18).
//
// PURE port-injected orchestration: the detector + normalization are pure (`../infection/*`); the event
// fetch, the case store, and the outbox emit are injected ports. The outbox emit is the genuinely-missing
// transactional-outbox infra → LAZY fail-closed at the composition root.
import type { schema } from "@wardenx/db";
import {
  OUTBREAK_WINDOW_DAYS,
  detectOutbreakClusters,
  toNewOutbreakCase,
} from "../infection/outbreak_detector";
import { normalizeSurveillanceRow } from "../infection/surveillance";
import { ALREADY_PROCESSED, type AlreadyProcessedResult, type ProcessingLogPort } from "./ports";

// ── the job + the port bundle ───────────────────────────────────────────────────────────────────────────

/** One `m30.outbreak_detection` job: re-evaluate the org's clusters after a surveillance event landed. */
export interface OutbreakDetectionJob {
  /** The BullMQ job id (the `processing_log` idempotency key — `(orgId, surveillanceEventId)`). */
  readonly jobId: string;
  readonly organizationId: string;
  /** The triggering `infection_surveillance_event` id (the event whose arrival enqueued this job). */
  readonly surveillanceEventId: string;
}

/** Fetches the org's surveillance events inside the trailing detection window (the detector's input set). */
export interface SurveillanceEventReadPort {
  recentForOrg(
    orgId: string,
    windowDays: number,
  ): Promise<readonly schema.InfectionSurveillanceEvent[]>;
}

/** The outbreak-case store port: dedupe against the live window, then create. */
export interface OutbreakCaseStorePort {
  findByWindow(
    providerEntityId: string,
    pathogen: string,
    bodySite: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<schema.InfectionOutbreakCase | null>;
  create(values: schema.NewInfectionOutbreakCase): Promise<schema.InfectionOutbreakCase>;
}

/** The §4.10 outbreak-opened outbox emit (M36 `outbreak_detected` high alert / M33 dashboard). */
export interface OutbreakDetectionOutboxPort {
  emitOutbreakOpened(payload: {
    readonly orgId: string;
    readonly caseId: string;
    readonly pathogen: string;
    readonly bodySite: string;
    readonly eventCount: number;
    readonly firstEventAt: string;
    readonly lastEventAt: string;
  }): Promise<void>;
}

/** The ports the outbreak-detection worker composes over. */
export interface OutbreakDetectionPorts {
  readonly processingLog: ProcessingLogPort;
  readonly events: SurveillanceEventReadPort;
  readonly cases: OutbreakCaseStorePort;
  readonly outbox: OutbreakDetectionOutboxPort;
}

// ── result ──────────────────────────────────────────────────────────────────────────────────────────────

/** What one detection pass reported. */
export type OutbreakDetectionResult =
  | AlreadyProcessedResult
  | {
      readonly outcome: "detected";
      readonly clustersDetected: number;
      readonly casesOpened: number;
      readonly openedCaseIds: readonly string[];
    };

// ── the worker ──────────────────────────────────────────────────────────────────────────────────────────

/** Build the `m30.outbreak_detection` processor over its bound ports. */
export function outbreakDetectionProcessor(
  ports: OutbreakDetectionPorts,
): (job: OutbreakDetectionJob) => Promise<OutbreakDetectionResult> {
  return (job) => handleOutbreakDetection(job, ports);
}

/**
 * Handle one `m30.outbreak_detection` job (§7.8 / WF-18). Opens with the §4.8 `processing_log` guard, runs
 * the pure 14-day cluster detector over the org's recent events, and opens an `infection_outbreak_case`
 * for each cluster not already covered by the `uq_outbreak_window` (idempotent — an existing window is a
 * skip). Thin — the clustering is pure; the fetch/store/emit are injected ports.
 */
export async function handleOutbreakDetection(
  job: OutbreakDetectionJob,
  ports: OutbreakDetectionPorts,
): Promise<OutbreakDetectionResult> {
  if (await ports.processingLog.isProcessed(job.jobId)) return ALREADY_PROCESSED;

  const rows = await ports.events.recentForOrg(job.organizationId, OUTBREAK_WINDOW_DAYS);
  const clusters = detectOutbreakClusters(rows.map(normalizeSurveillanceRow));

  const openedCaseIds: string[] = [];
  for (const cluster of clusters) {
    // §4.8 / V-18 idempotency: the `uq_outbreak_window` is the dedup oracle — an existing window is a skip.
    const existing = await ports.cases.findByWindow(
      cluster.providerEntityId,
      cluster.pathogen,
      cluster.bodySite,
      cluster.windowStart,
      cluster.windowEnd,
    );
    if (existing !== null) continue;

    const created = await ports.cases.create(toNewOutbreakCase(cluster));
    await ports.outbox.emitOutbreakOpened({
      orgId: job.organizationId,
      caseId: created.id,
      pathogen: cluster.pathogen,
      bodySite: cluster.bodySite,
      eventCount: cluster.triggeringEventCount,
      firstEventAt: cluster.windowStart.toISOString(),
      lastEventAt: cluster.windowEnd.toISOString(),
    });
    openedCaseIds.push(created.id);
  }

  await ports.processingLog.markProcessed(job.jobId, {
    outcome: "detected",
    clustersDetected: clusters.length,
    casesOpened: openedCaseIds.length,
  });
  return {
    outcome: "detected",
    clustersDetected: clusters.length,
    casesOpened: openedCaseIds.length,
    openedCaseIds,
  };
}

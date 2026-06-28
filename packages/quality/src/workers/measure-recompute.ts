// @wardenx/quality · workers — the `m30.measure_recompute` PURE processor (§4.8 / §7.1 / V-8).
//
// The body the `m30.measure_recompute` worker runs per dequeued job: recompute ONE
// `(measure, provider_entity, period)` HQRP value. It opens with the §4.8 `processing_log` idempotency
// guard (already_processed short-circuit), resolves the measure's registration + reporting period,
// fetches the calculator input through the injected data port (the one place a seam is reached — incl. the
// LIVE M10 HOPE consumer for the HOPE-derived measures, §4.4/M10-real), runs the PURE calculator, hashes
// the reproducibility snapshot, and append-only upserts `quality_measure_value` (insert the new current
// row + soft-supersede the prior, §3.3). A re-run whose snapshot content-hash matches the current row is a
// no-op (V-8 — identical inputs ⇒ identical `contentHash` ⇒ no duplicate row).
//
// PURE port-injected orchestration: every fact/effect is an injected port (no clock/RNG/Drizzle/BullMQ/
// `getSeam`/cross-module import). The decision cores ({@link decideThresholdBreach}) are unit-asserted
// independently of the I/O.
import type { schema } from "@wardenx/db";
import type { MeasureRegistration } from "../measures/registry";
import type { QualityMeasureValueResult } from "../measures/result";
import type { QualityHopeConsumer } from "../seams/consumed/m10-hope";
import { ALREADY_PROCESSED, type AlreadyProcessedResult, type ProcessingLogPort } from "./ports";

// ── the job + the port bundle ───────────────────────────────────────────────────────────────────────────

/**
 * One `m30.measure_recompute` job: recompute a single `(measure, provider_entity, period)` value. The
 * `computeVersion` rides the §2.6 idempotency key so a calculator-version bump forces a fresh recompute.
 */
export interface MeasureRecomputeJob {
  /** The BullMQ job id (the `processing_log` idempotency key). */
  readonly jobId: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly measureCode: string;
  /** ISO-8601 inclusive period start. */
  readonly periodStart: string;
  /** ISO-8601 exclusive period end. */
  readonly periodEnd: string;
  /** Why this recompute was enqueued (`nightly_cron` | `incremental_outbox` | `adhoc`). */
  readonly reason: string;
  /** The calculator version the §2.6 idempotency key dedups on. */
  readonly computeVersion: string;
  /** The membership/system that enqueued it (audit breadcrumb), or null for the cron. */
  readonly enqueuedBy?: string | null;
}

/**
 * The data fetch the worker reaches a seam for: resolve a measure's already-fetched calculator input. The
 * backend binds this over the M5–M18 read seams; the LIVE M10 HOPE consumer is handed in for the
 * HOPE-derived families (the one consumed seam wired at the composition root, §4.4). The return is the
 * base `ComputeMeasureInput` extended with the per-measure population data the calculator reduces; it is
 * type-erased to `unknown` here (the registry's calculator is itself type-erased to `(never) => result`).
 */
export interface MeasureInputProviderPort {
  resolveInput(
    request: {
      readonly registration: MeasureRegistration;
      readonly organizationId: string;
      readonly providerEntityId: string;
      readonly periodStart: string;
      readonly periodEnd: string;
    },
    seams: { readonly hope: QualityHopeConsumer },
  ): Promise<unknown>;
}

/** The append-only `quality_measure_value` store port (insert the new current row + soft-supersede prior). */
export interface MeasureValueStorePort {
  findCurrent(
    measureCode: string,
    providerEntityId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<schema.QualityMeasureValue | null>;
  insertValue(values: schema.NewQualityMeasureValue): Promise<schema.QualityMeasureValue>;
  supersede(id: string, supersededBy: string, supersededAt: Date): Promise<void>;
}

/** Clears the `measure_recompute_queue` debounce row after a successful recompute (the worker's drain). */
export interface MeasureRecomputeQueueClearPort {
  findPending(
    measureCode: string,
    providerEntityId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<{ readonly id: string } | null>;
  markProcessed(id: string, processedAt: Date): Promise<void>;
}

/** The §4.10 outbox emits the recompute worker makes (value emitted; QAPI-indicator threshold breach). */
export interface MeasureRecomputeOutboxPort {
  emitValueEmitted(payload: {
    readonly orgId: string;
    readonly measureId: string;
    readonly periodEnd: string;
    readonly valueId: string;
    readonly rate: number;
    readonly bandColor: string;
    readonly snapshotContentHash: string;
  }): Promise<void>;
  emitThresholdBreached(payload: {
    readonly orgId: string;
    readonly measureId: string;
    readonly periodEnd: string;
    readonly rate: number;
    readonly severityBand: string;
  }): Promise<void>;
}

/** The ports the recompute worker composes over. */
export interface MeasureRecomputePorts {
  readonly processingLog: ProcessingLogPort;
  /** The platform measure registry, keyed by measure code (the composition root builds it from the catalog). */
  readonly registrations: ReadonlyMap<string, MeasureRegistration>;
  /** The LIVE M10 HOPE consumer (bound via `getSeam` at boot — the one consumed seam, §4.4 / M10-real). */
  readonly hope: QualityHopeConsumer;
  readonly data: MeasureInputProviderPort;
  readonly values: MeasureValueStorePort;
  /** Optional debounce-queue drain (cleared on success when present). */
  readonly recomputeQueue?: MeasureRecomputeQueueClearPort;
  readonly outbox: MeasureRecomputeOutboxPort;
  /** Deterministic content hash over the reproducibility snapshot (bound to a sha256 helper at boot, V-5). */
  hashSnapshot(snapshot: QualityMeasureValueResult["computationSnapshot"]): string;
  /** Mints the new `quality_measure_value.id` (bound to `randomUUID` at boot). */
  newValueId(): string;
  now(): Date;
}

// ── result ──────────────────────────────────────────────────────────────────────────────────────────────

/** What one recompute reported. */
export type MeasureRecomputeResult =
  | AlreadyProcessedResult
  /** A re-run whose snapshot hash matched the current row — no new row inserted (V-8). */
  | { readonly outcome: "unchanged"; readonly measureCode: string; readonly valueId: string }
  /** A fresh value row was inserted (and the prior current row superseded). */
  | {
      readonly outcome: "recomputed";
      readonly measureCode: string;
      readonly valueId: string;
      readonly bandColor: string;
      readonly thresholdBreached: boolean;
    };

/** Raised when the job names a measure code with no registration (a catalog/registry drift — loud). */
export class MeasureRegistrationMissing extends Error {
  constructor(measureCode: string) {
    super(`measure '${measureCode}' has no registered calculator — cannot recompute an unregistered measure`);
    this.name = "MeasureRegistrationMissing";
  }
}

// ── the pure QAPI-indicator threshold-breach decision ───────────────────────────────────────────────────

/**
 * Decide whether this recompute crosses a QAPI indicator into the red band (PURE). A breach fires only on
 * a TRANSITION into red — the new value is `red` and the prior current value was absent or NOT red. A
 * value that was already red stays silent (the cadence re-alert is M36's job, not the recompute's), and an
 * `insufficient_n` value never breaches (V — no threshold fires below the reportable floor).
 */
export function decideThresholdBreach(
  prior: Pick<schema.QualityMeasureValue, "ratio"> | null,
  priorBand: string | null,
  next: QualityMeasureValueResult,
): boolean {
  if (next.bandColor !== "red") return false;
  return priorBand !== "red";
}

// ── the worker ──────────────────────────────────────────────────────────────────────────────────────────

/** Build the `m30.measure_recompute` processor over its bound ports (the M33 `mvRefreshProcessor` shape). */
export function measureRecomputeProcessor(
  ports: MeasureRecomputePorts,
): (job: MeasureRecomputeJob) => Promise<MeasureRecomputeResult> {
  return (job) => handleMeasureRecompute(job, ports);
}

/**
 * Handle one `m30.measure_recompute` job (§7.1). Opens with the §4.8 `processing_log` guard, recomputes the
 * value through the pure calculator, and append-only upserts `quality_measure_value`. Idempotent twice
 * over: the `processing_log` short-circuits a replay, and an identical snapshot content-hash short-circuits
 * the insert (V-8). Thin — the calculator + the breach decision are pure; every effect is an injected port.
 *
 * @throws {MeasureRegistrationMissing} the measure code has no registered calculator
 */
export async function handleMeasureRecompute(
  job: MeasureRecomputeJob,
  ports: MeasureRecomputePorts,
): Promise<MeasureRecomputeResult> {
  // §4.8 consumer-idempotency guard — safe to replay from the DLQ without double-effects.
  if (await ports.processingLog.isProcessed(job.jobId)) return ALREADY_PROCESSED;

  const registration = ports.registrations.get(job.measureCode);
  if (registration === undefined) throw new MeasureRegistrationMissing(job.measureCode);

  const periodStart = new Date(job.periodStart);
  const periodEnd = new Date(job.periodEnd);

  // The single seam reach: fetch the already-shaped calculator input (HOPE-derived families consume the
  // live M10 HOPE rollups handed in here). The input is type-erased to mirror the registry's calculator.
  const input = await ports.data.resolveInput(
    {
      registration,
      organizationId: job.organizationId,
      providerEntityId: job.providerEntityId,
      periodStart: job.periodStart,
      periodEnd: job.periodEnd,
    },
    { hope: ports.hope },
  );

  const result = registration.calculator(input as never);
  const snapshotContentHash = ports.hashSnapshot(result.computationSnapshot);

  // V-8 idempotency: a re-run whose snapshot hash matches the current row is a no-op (no duplicate row).
  const current = await ports.values.findCurrent(
    job.measureCode,
    job.providerEntityId,
    periodStart,
    periodEnd,
  );
  if (current !== null && current.snapshotContentHash === snapshotContentHash) {
    await ports.processingLog.markProcessed(job.jobId, { outcome: "unchanged", valueId: current.id });
    return { outcome: "unchanged", measureCode: job.measureCode, valueId: current.id };
  }

  const now = ports.now();
  const valueId = ports.newValueId();
  await ports.values.insertValue({
    id: valueId,
    measureCode: job.measureCode,
    providerEntityId: job.providerEntityId,
    organizationId: job.organizationId,
    periodKind: registration.periodKind,
    periodStart,
    periodEnd,
    numerator: result.numerator,
    denominator: result.denominator,
    // numeric(6,4) → string|null; the `insufficient_n` band carries a null rate (V).
    ratio: result.rate === null ? null : result.rate.toFixed(4),
    thresholdMet: result.thresholdMet,
    computationSnapshot: result.computationSnapshot,
    snapshotContentHash,
    calculatorVersion: registration.calculatorVersion,
    computedAt: now,
  });

  // Soft-supersede the prior current row in the SAME tx (the backend wraps the processor) — §3.3.
  if (current !== null) await ports.values.supersede(current.id, valueId, now);

  // Drain the debounce work-list row, if one was pending for this triple.
  if (ports.recomputeQueue !== undefined) {
    const pending = await ports.recomputeQueue.findPending(
      job.measureCode,
      job.providerEntityId,
      periodStart,
      periodEnd,
    );
    if (pending !== null) await ports.recomputeQueue.markProcessed(pending.id, now);
  }

  // §4.10 — every append emits `m30.measure.value_emitted` (M28 FHIR MeasureReport / M33 dashboard tile).
  await ports.outbox.emitValueEmitted({
    orgId: job.organizationId,
    measureId: job.measureCode,
    periodEnd: job.periodEnd,
    valueId,
    rate: result.rate ?? 0,
    bandColor: result.bandColor,
    snapshotContentHash,
  });

  const priorBand = current === null ? null : bandOf(current);
  const thresholdBreached = decideThresholdBreach(current, priorBand, result);
  if (thresholdBreached) {
    await ports.outbox.emitThresholdBreached({
      orgId: job.organizationId,
      measureId: job.measureCode,
      periodEnd: job.periodEnd,
      rate: result.rate ?? 0,
      severityBand: result.bandColor,
    });
  }

  await ports.processingLog.markProcessed(job.jobId, { outcome: "recomputed", valueId });
  return {
    outcome: "recomputed",
    measureCode: job.measureCode,
    valueId,
    bandColor: result.bandColor,
    thresholdBreached,
  };
}

/** Recover the public band of a persisted value row (the row carries numerator/denominator/thresholdMet,
 *  not the band string; `ratio === null` ⇒ `insufficient_n`, else `thresholdMet` drives green/red). */
function bandOf(row: Pick<schema.QualityMeasureValue, "ratio" | "thresholdMet">): string {
  if (row.ratio === null) return "insufficient_n";
  if (row.thresholdMet === null) return "green";
  return row.thresholdMet ? "green" : "red";
}

// @chartwarden/quality · workers — the `m30.cahps_export` PURE processor (§4.8 / §7.2 W-14).
//
// The body the `m30.cahps_export` worker runs per dequeued job: render (and optionally push) one month's
// decedent sample to the org's CAHPS-Hospice survey vendor. It opens with the §4.8 `processing_log`
// guard, resolves the org's live `CahpsVendorAdapter` (the per-org registry — cross-tenant invocation is
// structurally impossible), decrypts each `cahps_decedent_sample` row's caregiver contact to the in-flight
// vendor-export shape (PHI; never persisted in the clear, §8), calls `adapter.renderExport` (+ optional
// `pushExport`), stamps the sample rows `exported`, and emits `m30.cahps.export_completed`. On the §4.8
// terminal-attempt failure path it flips the rows to `export_failed` + emits `m30.cahps.export_failed`
// before rethrowing so BullMQ moves the job to the DLQ (the M33 W-R-06 exhaustion precedent).
//
// PURE port-injected orchestration: the only infra-touching code is the bound adapters/repos/outbox the
// backend injects. The PHI-decrypt + vendor-config ports are the genuinely-missing M1 envelope-DEK infra,
// so they are LAZY fail-closed (the M33 drilldown-encrypt precedent: deny + fail rather than leak/no-op).
import type { schema } from "@chartwarden/db";
import type { CahpsDecedentSampleRow, CahpsVendor, CahpsVendorAdapter } from "../cahps/adapter";
import { M30_QUEUE_PARAMS } from "./params";
import { ALREADY_PROCESSED, type AlreadyProcessedResult, type ProcessingLogPort } from "./ports";

// ── the job + the port bundle ───────────────────────────────────────────────────────────────────────────

/** One `m30.cahps_export` job: export an org's decedent sample for a cycle month to its bound vendor. */
export interface CahpsExportJob {
  /** The BullMQ job id (the `processing_log` idempotency key). */
  readonly jobId: string;
  readonly organizationId: string;
  /** First-day-of-month ISO date — the `cahps_decedent_sample` partition key (the cycle being exported). */
  readonly samplingCycleMonth: string;
  /** ISO-8601 inclusive sample-period start (vendor-facing). */
  readonly samplePeriodStart: string;
  /** ISO-8601 inclusive sample-period end (vendor-facing). */
  readonly samplePeriodEnd: string;
  /** The active `cahps_vendor_binding` id (the §4.8 idempotency-key component). */
  readonly vendorBindingId: string;
  /** The 0-based BullMQ attempt index of THIS run (drives the §4.8 terminal export_failed gate). */
  readonly attempt?: number;
  /** The `cahps_export_job` row (R-14) this run drives; absent for a cron-triggered export with no job row. */
  readonly exportId?: string;
}

/**
 * Resolves the org's live CAHPS adapter (bound to `CahpsAdapterRegistry.resolve`; 503 when unconfigured). May be
 * async: a worker has no boot-time registry, so the production resolver loads the org's active binding, opens its
 * sealed configuration and instantiates the adapter per job.
 */
export interface CahpsAdapterResolvePort {
  resolve(orgId: string): CahpsVendorAdapter | Promise<CahpsVendorAdapter>;
}

/**
 * GAP-087 — the durable export-job row (`cahps_export_job`) the R-14 route created and R-15 reads back. Optional: a
 * run with no `exportId` (or no port bound) behaves exactly as before. The rendered file is persisted (sealed by
 * the implementation) BEFORE it is pushed, so a vendor outage after the push never loses the artifact and a retry
 * never has to re-render PHI it already produced.
 */
export interface CahpsExportJobPort {
  markRunning(job: CahpsExportJob): Promise<void>;
  storeFile(
    job: CahpsExportJob,
    file: { readonly filename: string; readonly mimeType: string; readonly bytes: Buffer },
    decedentCount: number,
  ): Promise<void>;
  complete(
    job: CahpsExportJob,
    push:
      | { readonly status: "pushed"; readonly vendorJobId: string }
      | { readonly status: "no_push" },
  ): Promise<void>;
  fail(job: CahpsExportJob, reason: string): Promise<void>;
}

/** The decedent-sample store port: load the cycle's pending rows + stamp export/failure status. */
export interface CahpsSampleStorePort {
  /** The `pending_export` rows for the cycle (oldest-created first) — the export worklist. */
  listPendingForCycle(
    orgId: string,
    samplingCycleMonth: string,
  ): Promise<readonly schema.CahpsDecedentSample[]>;
  /** Stamp a row `exported` (+ vendor-ack telemetry). Composite PK (id + cycle month). */
  markExported(
    id: string,
    samplingCycleMonth: string,
    patch: { exportedAt: Date; vendorAckRef: string | null },
  ): Promise<void>;
  /** Flip a row to `export_failed` on the §4.8 terminal attempt. Composite PK. */
  markExportFailed(id: string, samplingCycleMonth: string): Promise<void>;
}

/**
 * Decrypts a `cahps_decedent_sample` row's envelope-encrypted caregiver contact into the in-flight vendor
 * export shape (PHI; §8 — never persisted in the clear). The vendor-of-record's `death_source` is NOT
 * forwarded (§4.13). FAIL-CLOSED at the composition root until the M1 envelope-DEK helper is bound (the
 * M33 drilldown-encrypt precedent: a run denies rather than exporting un-decrypted / leaking plaintext).
 */
export interface CahpsCaregiverDecryptPort {
  toVendorRow(row: schema.CahpsDecedentSample): Promise<CahpsDecedentSampleRow>;
}

/** Loads the decrypted vendor-binding config `pushExport` needs (envelope-decrypt; FAIL-CLOSED until bound). */
export interface CahpsBindingConfigPort {
  load(orgId: string, vendorBindingId: string): Promise<Record<string, unknown>>;
}

/** The §4.10 outbox emits the export worker makes (completion; terminal failure). */
export interface CahpsExportOutboxPort {
  emitExportCompleted(payload: {
    readonly orgId: string;
    readonly exportId: string;
    readonly samplePeriod: { start: string; end: string };
    readonly vendor: string;
    readonly status: string;
  }): Promise<void>;
  emitExportFailed(payload: {
    readonly orgId: string;
    readonly samplePeriod: { start: string; end: string };
    readonly vendor: string;
    readonly reason: string;
  }): Promise<void>;
}

/** The ports the export worker composes over. */
export interface CahpsExportPorts {
  readonly processingLog: ProcessingLogPort;
  readonly adapters: CahpsAdapterResolvePort;
  readonly samples: CahpsSampleStorePort;
  readonly decrypt: CahpsCaregiverDecryptPort;
  readonly bindingConfig: CahpsBindingConfigPort;
  readonly outbox: CahpsExportOutboxPort;
  /** GAP-087 — the durable job row; omitted ⇒ no job bookkeeping. */
  readonly exports?: CahpsExportJobPort;
  /** Override the §4.8 retry budget (default `M30_QUEUE_PARAMS.cahpsExport.attempts`). */
  readonly maxAttempts?: number;
  now(): Date;
}

// ── result ──────────────────────────────────────────────────────────────────────────────────────────────

/** What one export reported. */
export type CahpsExportResult =
  | AlreadyProcessedResult
  /** The sample rendered + (optionally) pushed; rows stamped `exported`. */
  | {
      readonly outcome: "exported";
      readonly exportedCount: number;
      readonly pushed: boolean;
    };

/** Raised when render/push fails — rethrown so BullMQ applies the §4.8 backoff / DLQ. On the terminal
 *  attempt the rows are already flipped to `export_failed` + the failure event emitted before this throws. */
export class CahpsExportError extends Error {
  constructor(
    public readonly organizationId: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(`CAHPS export for org '${organizationId}' failed: ${reason}`, options);
    this.name = "CahpsExportError";
  }
}

// ── the worker ──────────────────────────────────────────────────────────────────────────────────────────

/** Build the `m30.cahps_export` processor over its bound ports. */
export function cahpsExportProcessor(
  ports: CahpsExportPorts,
): (job: CahpsExportJob) => Promise<CahpsExportResult> {
  return (job) => handleCahpsExport(job, ports);
}

/**
 * Handle one `m30.cahps_export` job (§7.2). Opens with the §4.8 `processing_log` guard; resolves the org's
 * vendor adapter; decrypts each pending sample row to the vendor-export shape; renders (+ optionally
 * pushes) the file; stamps the rows `exported` and emits `m30.cahps.export_completed`. On a failure that
 * exhausts the §4.8 retry budget the rows flip to `export_failed`, `m30.cahps.export_failed` is emitted,
 * and the error is rethrown so the job moves to the DLQ (the M33 exhaustion precedent). Thin — every
 * effect is an injected port; the PHI-decrypt + config ports fail closed until the M1 DEK helper is bound.
 */
export async function handleCahpsExport(
  job: CahpsExportJob,
  ports: CahpsExportPorts,
): Promise<CahpsExportResult> {
  if (await ports.processingLog.isProcessed(job.jobId)) return ALREADY_PROCESSED;
  if (job.exportId) await ports.exports?.markRunning(job);

  const samplePeriod = { start: job.samplePeriodStart, end: job.samplePeriodEnd };
  const pending = await ports.samples.listPendingForCycle(
    job.organizationId,
    job.samplingCycleMonth,
  );

  // Resolve outside the try so an unconfigured adapter (503) is a clean non-retried config error, not a
  // terminal export_failed (an org with no binding should not poison its sample as permanently failed).
  let adapter: CahpsVendorAdapter;
  try {
    adapter = await ports.adapters.resolve(job.organizationId);
  } catch (cause) {
    if (job.exportId) {
      await ports.exports?.fail(job, cause instanceof Error ? cause.message : String(cause));
    }
    throw cause;
  }

  try {
    const config = await ports.bindingConfig.load(job.organizationId, job.vendorBindingId);
    const decedents: CahpsDecedentSampleRow[] = [];
    for (const row of pending) decedents.push(await ports.decrypt.toVendorRow(row));

    const file = await adapter.renderExport(job.organizationId, samplePeriod, decedents);
    // Persist the artifact BEFORE the vendor push (see CahpsExportJobPort).
    if (job.exportId) await ports.exports?.storeFile(job, file, decedents.length);
    const push = await adapter.pushExport(job.organizationId, file, config);
    const vendorAckRef = push.status === "pushed" ? push.vendorJobId : null;
    if (job.exportId) {
      await ports.exports?.complete(
        job,
        push.status === "pushed"
          ? { status: "pushed", vendorJobId: push.vendorJobId }
          : { status: "no_push" },
      );
    }

    const exportedAt = ports.now();
    for (const row of pending) {
      await ports.samples.markExported(row.id, job.samplingCycleMonth, {
        exportedAt,
        vendorAckRef,
      });
    }

    await ports.outbox.emitExportCompleted({
      orgId: job.organizationId,
      exportId: job.exportId ?? job.vendorBindingId,
      samplePeriod,
      vendor: vendorLabel(adapter.vendor),
      status: push.status,
    });

    await ports.processingLog.markProcessed(job.jobId, {
      outcome: "exported",
      exportedCount: pending.length,
      pushed: push.status === "pushed",
    });
    return { outcome: "exported", exportedCount: pending.length, pushed: push.status === "pushed" };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const maxAttempts = ports.maxAttempts ?? M30_QUEUE_PARAMS.cahpsExport.attempts;
    const isTerminal = (job.attempt ?? 0) + 1 >= maxAttempts;

    if (isTerminal) {
      // §4.8 — on the final failed attempt the cycle's rows are marked export_failed + the event emitted;
      // the QAPI Coordinator manually re-triggers via R-14. Then rethrow so BullMQ moves it to the DLQ.
      for (const row of pending)
        await ports.samples.markExportFailed(row.id, job.samplingCycleMonth);
      if (job.exportId) await ports.exports?.fail(job, reason);
      await ports.outbox.emitExportFailed({
        orgId: job.organizationId,
        samplePeriod,
        vendor: vendorLabel(adapter.vendor),
        reason,
      });
    }
    throw new CahpsExportError(job.organizationId, reason, { cause });
  }
}

/** The vendor display identity as a wire string (the outbox payload carries the label, not the enum). */
function vendorLabel(vendor: CahpsVendor): string {
  return vendor;
}

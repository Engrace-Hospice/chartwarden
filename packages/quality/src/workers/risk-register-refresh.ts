// @chartwarden/quality · workers — the `m30.risk_register_refresh` PURE processor (§4.8 / §7.9 / D13 WF-20).
//
// The body the `m30.risk_register_refresh` worker runs per org (serialized per org, concurrency 1): REFRESH
// the `risk_register_view` MATERIALIZED VIEW CONCURRENTLY for the org, then shape the unified register rows
// (PURE {@link buildRiskRegister}) for the refresh telemetry + the `m30.risk_register.refreshed` emit. It
// opens with the §4.8 `processing_log` guard. The SQL exec (`REFRESH MATERIALIZED VIEW CONCURRENTLY`) is an
// injected port — the pure part is the in-process projection that MIRRORS the SQL view (so the two cannot
// drift, D13). On a refresh failure the worker rethrows so BullMQ retries / DLQs; after exhaustion the
// R-95 read serves the view STALE with a `data_as_of` header (§4.8) — the refresh never blocks reads.
//
// PURE port-injected orchestration: the row-shaping is pure (`../risk_register/refresh`); the REFRESH exec,
// the source loader, and the outbox emit are injected ports (the emit fail-closed until the outbox lands).
import { type RiskRegisterSources, buildRiskRegister } from "../risk_register/refresh";
import { ALREADY_PROCESSED, type AlreadyProcessedResult, type ProcessingLogPort } from "./ports";

// ── the job + the port bundle ───────────────────────────────────────────────────────────────────────────

/** One `m30.risk_register_refresh` job: refresh + reproject one org's unified risk register. */
export interface RiskRegisterRefreshJob {
  /** The BullMQ job id (the `processing_log` idempotency key — `(orgId, dateBucket)`). */
  readonly jobId: string;
  readonly organizationId: string;
  /** R-96 force flag (cron sets true) — carried for telemetry; the refresh runs either way. */
  readonly force: boolean;
}

/**
 * Executes `REFRESH MATERIALIZED VIEW CONCURRENTLY risk_register_view` for one org (the §3.3 MV). The
 * backend binds this over `db.execute(sql\`…\`)` on the PRIMARY pool; CONCURRENTLY keeps the view readable
 * during the refresh (R-95 reads never block).
 */
export interface RiskRegisterMvRefreshPort {
  refreshConcurrently(orgId: string): Promise<void>;
}

/** Loads the four open-risk source collections the in-process projection unions (D13). */
export interface RiskRegisterSourceReadPort {
  loadOpenRiskSources(orgId: string): Promise<RiskRegisterSources>;
}

/** The §4.10 risk-register-refreshed outbox emit (M33 unified-risk view). */
export interface RiskRegisterRefreshOutboxPort {
  emitRefreshed(payload: {
    readonly orgId: string;
    readonly refreshedAt: string;
    readonly totalRows: number;
  }): Promise<void>;
}

/** The ports the risk-register-refresh worker composes over. */
export interface RiskRegisterRefreshPorts {
  readonly processingLog: ProcessingLogPort;
  readonly refresh: RiskRegisterMvRefreshPort;
  readonly sources: RiskRegisterSourceReadPort;
  readonly outbox: RiskRegisterRefreshOutboxPort;
  now(): Date;
}

// ── result ──────────────────────────────────────────────────────────────────────────────────────────────

/** What one refresh reported. */
export type RiskRegisterRefreshResult =
  | AlreadyProcessedResult
  | { readonly outcome: "refreshed"; readonly totalRows: number; readonly refreshedAt: string };

// ── the worker ──────────────────────────────────────────────────────────────────────────────────────────

/** Build the `m30.risk_register_refresh` processor over its bound ports. */
export function riskRegisterRefreshProcessor(
  ports: RiskRegisterRefreshPorts,
): (job: RiskRegisterRefreshJob) => Promise<RiskRegisterRefreshResult> {
  return (job) => handleRiskRegisterRefresh(job, ports);
}

/**
 * Handle one `m30.risk_register_refresh` job (§7.9 / WF-20). Opens with the §4.8 `processing_log` guard,
 * REFRESHes the `risk_register_view` MV CONCURRENTLY, reprojects the unified register (pure) for the row
 * count, and emits `m30.risk_register.refreshed`. A refresh failure propagates (BullMQ retries / DLQs;
 * exhaustion serves the view stale, §4.8). Thin — the projection is pure; refresh/sources/emit are ports.
 */
export async function handleRiskRegisterRefresh(
  job: RiskRegisterRefreshJob,
  ports: RiskRegisterRefreshPorts,
): Promise<RiskRegisterRefreshResult> {
  if (await ports.processingLog.isProcessed(job.jobId)) return ALREADY_PROCESSED;

  // D3 / §3.3 — the one write path: REFRESH the MV on the primary (CONCURRENTLY keeps R-95 reads live).
  await ports.refresh.refreshConcurrently(job.organizationId);

  // Reproject the register in-process (the pure projection that mirrors the SQL view, D13) for telemetry.
  const sources = await ports.sources.loadOpenRiskSources(job.organizationId);
  const rows = buildRiskRegister(sources);

  const refreshedAt = ports.now().toISOString();
  await ports.outbox.emitRefreshed({
    orgId: job.organizationId,
    refreshedAt,
    totalRows: rows.length,
  });

  await ports.processingLog.markProcessed(job.jobId, {
    outcome: "refreshed",
    totalRows: rows.length,
  });
  return { outcome: "refreshed", totalRows: rows.length, refreshedAt };
}

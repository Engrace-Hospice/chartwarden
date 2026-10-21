// @chartwarden/quality · workers — the shared port idiom every §4.8 processor composes over.
//
// EVERY fact + effect a worker touches is one of these tiny injected ports; the processors
// (`./measure-recompute.ts` / `./cahps-export.ts` / `./outbreak-detection.ts` /
// `./risk-register-refresh.ts` / `./crons.ts`) are PURE orchestration over them — no clock, no RNG, no
// Drizzle, no BullMQ, no `getSeam`, no cross-module import. The backend composition root binds the real
// adapters (the M30 repositories, the M10 HOPE seam reached via `getSeam`, the active-org enumerator, the
// CAHPS adapter registry); any port whose infra is genuinely unlanded (the transactional-outbox row emit,
// the M1 envelope-DEK decrypt, the live M36 alert router) is bound to a LAZY fail-closed thunk via
// {@link unboundWorkerPort} — it throws only when a JOB RUNS, never at port-bundle construction (the M34
// eager-bind gotcha: the host must boot with the BullMQ connection enabled even when an adapter is absent).

// ── the §4.8 consumer-idempotency guard (the `processingLog` short-circuit) ──────────────────────────────

/**
 * The §4.8 consumer-idempotency assertion port: every M30 worker opens its `process()` with an
 * `already_processed` short-circuit against the `processing_log` (the application-layer complement to
 * BullMQ `removeOnComplete`, so workers are safe to replay from the DLQ without double-effects). The
 * backend binds this over the M1-owned `processing_log` table; it is BINDABLE (not fail-closed).
 */
export interface ProcessingLogPort {
  /** True iff a terminal `processing_log` row already exists for this BullMQ job id. */
  isProcessed(jobId: string): Promise<boolean>;
  /** Stamp the terminal `processing_log` row (the job's outcome summary) after the effects land. */
  markProcessed(jobId: string, summary: Record<string, unknown>): Promise<void>;
}

/** The uniform `already_processed` short-circuit result every processor may return (the §4.8 replay guard). */
export interface AlreadyProcessedResult {
  readonly skipped: true;
  readonly reason: "already_processed";
}

/** The canonical `already_processed` value (one shared literal so callers compare structurally). */
export const ALREADY_PROCESSED: AlreadyProcessedResult = {
  skipped: true,
  reason: "already_processed",
} as const;

// ── active-org enumeration (the cron fan-out source) ─────────────────────────────────────────────────────

/** One active org the platform-scoped cron enumeration returns (the fan-out unit). */
export interface ActiveOrg {
  readonly organizationId: string;
}

/** Lists the active orgs a cron fans work out across (bound over the M2 org reader under `withPlatformContext`). */
export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly ActiveOrg[]>;
}

// ── fail-closed unbound-port idiom (the M33 `M33RefreshPortUnbound` / M34 precedent) ─────────────────────

/**
 * Raised when a worker port the composition root left unbound is exercised by a running job. The backend
 * binds each genuinely-missing port (the transactional-outbox row emit, the M1 envelope-DEK decrypt, the
 * live M36 alert router) to a LAZY `() => unboundWorkerPort(...)` thunk so the throw happens at job-run
 * time, never at construction (the host must still boot with the BullMQ connection enabled).
 */
export class M30WorkerPortUnbound extends Error {
  constructor(
    public readonly port: string,
    reason: string,
  ) {
    super(`M30 worker port '${port}' is not bound to a real adapter: ${reason}`);
    this.name = "M30WorkerPortUnbound";
  }
}

/** Throw the unbound-port error. Use ONLY inside a thunk so it is lazy — never call it eagerly at
 *  port-bundle construction (the M34 eager-bind gotcha). */
export function unboundWorkerPort(port: string, reason: string): never {
  throw new M30WorkerPortUnbound(port, reason);
}

// @chartwarden/reporting · session — the `withReportSession` read-replica session wrapper (M33 §8.1.2 / D3 / D14).
//
// EVERY M33 read worker/route opens its database session through this wrapper. It runs `fn` inside a SINGLE
// read-only transaction on the read REPLICA, with three GUCs applied (the injected M1 `read_replica_session`
// port issues the `SET LOCAL`s):
//   - `app.org_id = :orgId`                       — the RLS scope. WITHOUT THIS GUC EVERY RLS-BOUND QUERY
//                                                    RETURNS ZERO ROWS BY CONSTRUCTION (fail-closed, D3).
//   - `default_transaction_read_only = TRUE`      — the replica never accepts a write (defence in depth).
//   - `statement_timeout = :timeout`              — tiered (5s tile / 30s export / 300s scheduled+CSV, D3).
// The ONE exception is the MV-refresh worker, which writes on the PRIMARY and so does NOT use this wrapper
// (refresh/refresh-worker.ts — D3).
//
// D14 DEGRADE PATH (circuit-breaker over replica lag): when the injected lag gate reports the replica is
// breached (lag > threshold, default 600s, OR the breaker is open) this wrapper does NOT read stale replica
// data. If the caller supplied a Valkey-cache `onDegradedFallback` (the tile read path), it serves that;
// otherwise it throws `DegradedError("report-replica", …)` so the route surfaces the degraded state rather
// than silently serving zero/stale rows. The lag reading itself is INFORMATIONAL for the freshness chip —
// the gate here only fires the breaker decision; tiles still render from the last refreshed snapshot.
//
// PURITY (the M34 port-injected precedent): this is a pure wrapper over an injected `ReadReplicaSessionPort`
// (the M1 helper) + an optional `ReplicaLagGatePort` — no M1 import, no `pg`/Drizzle pool construction, no
// `getSeam`. The composition root (P2C) binds the real M1 `read_replica_session` helper + the lag gate over
// the `report.lag_probe` state the same fail-closed way the refresh ports bind. The {@link decideReplicaGate}
// decision core is a total function unit-asserted independently of any I/O.
import { DegradedError } from "@chartwarden/types";
import type { ReportingDb } from "../repositories/db";

// ── statement-timeout tiers (§8.1.2 / D3) ─────────────────────────────────────────────────────────────────

/**
 * The three `statement_timeout` budgets keyed by read tier (§8.1.2 / D3). `tile` (5s) covers dashboard
 * tile + preview reads; `export` (30s) covers interactive export builds; `scheduled` (300s) covers the
 * scheduled-run snapshot query + the chunked CSV stream (and is also the budget the MV-refresh worker uses
 * on the PRIMARY, though that path bypasses this wrapper).
 */
export const REPORT_SESSION_STATEMENT_TIMEOUTS_MS = {
  tile: 5_000,
  export: 30_000,
  scheduled: 300_000,
} as const;

/** The read tier a session opens under (selects its §8.1.2 `statement_timeout` budget). */
export type ReportSessionTier = keyof typeof REPORT_SESSION_STATEMENT_TIMEOUTS_MS;

/** Resolve the §8.1.2 `statement_timeout` (ms) for a read tier. */
export function statementTimeoutMsForTier(tier: ReportSessionTier): number {
  return REPORT_SESSION_STATEMENT_TIMEOUTS_MS[tier];
}

/** D14: the default replica-lag freshness threshold (10 min). Above this the breaker degrades the read. */
export const DEFAULT_REPLICA_LAG_THRESHOLD_SECONDS = 600 as const;

// ── injected ports ────────────────────────────────────────────────────────────────────────────────────────

/** The request the wrapper hands the M1 `read_replica_session` helper: the RLS org scope + read-only flag +
 *  the tier's `statement_timeout`. The helper applies all three as `SET LOCAL` inside one transaction. */
export interface ReplicaSessionRequest {
  /** The `app.org_id` RLS scope GUC. Without it every RLS-bound query returns zero rows (D3 fail-closed). */
  readonly orgId: string;
  /** The `statement_timeout` GUC in ms (the §8.1.2 tier budget). */
  readonly statementTimeoutMs: number;
  /** Always TRUE — the replica session sets `default_transaction_read_only = TRUE` (defence in depth). */
  readonly readOnly: true;
}

/**
 * The M1-owned read-replica session port (`read_replica_session`, §8.1.2). The composition root binds the real
 * M1 helper at boot (fail-closed thunk until then). It opens ONE replica transaction, applies the three
 * `SET LOCAL` GUCs from {@link ReplicaSessionRequest}, runs `fn` against the scoped handle, and commits.
 * On replica down/lag M1 transparently fails over to the primary (M02 §8.1.2) — that failover is the port's
 * concern, not this wrapper's.
 *
 * TODO(integrator — M1 read_replica_session): bind this to the M1 helper at the M33 worker-wiring site (P2C).
 */
export interface ReadReplicaSessionPort {
  withSession<T>(req: ReplicaSessionRequest, fn: (db: ReportingDb) => Promise<T>): Promise<T>;
}

/** One sample of the replica-lag gate: the worst current replay lag + whether the breaker is tripped open. */
export interface ReplicaLagGateReading {
  readonly lagSeconds: number;
  /** True when the `report.lag_probe` two-probe hysteresis has confirmed a breach (D14). */
  readonly breakerOpen: boolean;
}

/** Reads the current replica-lag breaker state (bound at boot over the `report.lag_probe` state / Valkey). */
export interface ReplicaLagGatePort {
  read(): Promise<ReplicaLagGateReading>;
}

/** The ports `withReportSession` composes over: the replica session opener + an optional lag breaker gate. */
export interface WithReportSessionPorts {
  readonly replica: ReadReplicaSessionPort;
  /** Optional D14 lag breaker. When omitted the session always reads the replica (no degrade gate). */
  readonly lag?: ReplicaLagGatePort;
}

// ── the pure D14 gate decision ────────────────────────────────────────────────────────────────────────────

/** The replica-gate decision: read the replica, serve the cache fallback, or degrade (throw). */
export type ReplicaGateDecision = "serve_replica" | "serve_fallback" | "degrade";

/**
 * Decide the D14 replica gate for one read (PURE, total). The replica is "breached" when the breaker is open
 * OR the sampled lag strictly exceeds the threshold. On a breach: serve the cache fallback if the caller
 * supplied one (the tile read path), else degrade (the wrapper throws `DegradedError`). Otherwise read the
 * replica. A non-breached read NEVER consults the fallback.
 */
export function decideReplicaGate(input: {
  readonly lagSeconds: number;
  readonly breakerOpen: boolean;
  readonly thresholdSeconds: number;
  readonly hasFallback: boolean;
}): ReplicaGateDecision {
  const breached = input.breakerOpen || input.lagSeconds > input.thresholdSeconds;
  if (!breached) return "serve_replica";
  return input.hasFallback ? "serve_fallback" : "degrade";
}

// ── errors ────────────────────────────────────────────────────────────────────────────────────────────────

/** Raised when a session is opened with an empty `orgId` — fail-closed before a query that would silently
 *  return zero rows under an unset `app.org_id` GUC (D3). A missing scope is a bug, not an empty result. */
export class ReportSessionScopeMissing extends Error {
  constructor() {
    super(
      "withReportSession requires a non-empty orgId — an unset app.org_id GUC returns zero rows by construction (D3)",
    );
    this.name = "ReportSessionScopeMissing";
  }
}

// ── the wrapper ───────────────────────────────────────────────────────────────────────────────────────────

/** Options for one `withReportSession` read: the RLS scope, the tier budget, and the optional D14 fallback. */
export interface ReportSessionOptions<T> {
  /** The `app.org_id` RLS scope (the tenant the read is for). */
  readonly orgId: string;
  /** The read tier → its §8.1.2 `statement_timeout` budget. */
  readonly tier: ReportSessionTier;
  /** Override the D14 lag threshold (default {@link DEFAULT_REPLICA_LAG_THRESHOLD_SECONDS}). */
  readonly lagThresholdSeconds?: number;
  /** D14: the Valkey-cache fallback served when the replica is degraded (tile reads). Omit to degrade-throw. */
  readonly onDegradedFallback?: () => Promise<T>;
}

/**
 * Run `fn` inside a single read-only replica transaction scoped to `opts.orgId`, with the tier's
 * `statement_timeout` applied (§8.1.2). When a lag gate is bound and the replica is breached (D14) the read
 * is served from `onDegradedFallback` if present, else `DegradedError("report-replica", …)` is thrown — the
 * wrapper never reads stale replica data past the breaker. Thin orchestration over {@link decideReplicaGate}
 * + the injected {@link ReadReplicaSessionPort}; the GUC application lives in the M1 helper the port binds.
 *
 * @throws {ReportSessionScopeMissing} `opts.orgId` is empty (fail-closed before an unscoped read)
 * @throws {DegradedError}             the replica is breached and no cache fallback was supplied (D14)
 */
export async function withReportSession<T>(
  opts: ReportSessionOptions<T>,
  ports: WithReportSessionPorts,
  fn: (db: ReportingDb) => Promise<T>,
): Promise<T> {
  if (opts.orgId.length === 0) throw new ReportSessionScopeMissing();

  const threshold = opts.lagThresholdSeconds ?? DEFAULT_REPLICA_LAG_THRESHOLD_SECONDS;
  if (ports.lag !== undefined) {
    const reading = await ports.lag.read();
    const decision = decideReplicaGate({
      lagSeconds: reading.lagSeconds,
      breakerOpen: reading.breakerOpen,
      thresholdSeconds: threshold,
      hasFallback: opts.onDegradedFallback !== undefined,
    });
    if (decision === "serve_fallback") {
      // `onDegradedFallback` is defined here (hasFallback drove the decision); the non-null guard keeps it total.
      return (opts.onDegradedFallback ?? (() => Promise.reject(new ReportSessionScopeMissing())))();
    }
    if (decision === "degrade") {
      throw new DegradedError(
        "report-replica",
        `read replica lag ${reading.lagSeconds}s exceeds ${threshold}s and no cache fallback is available`,
      );
    }
  }

  return ports.replica.withSession(
    { orgId: opts.orgId, statementTimeoutMs: statementTimeoutMsForTier(opts.tier), readOnly: true },
    fn,
  );
}

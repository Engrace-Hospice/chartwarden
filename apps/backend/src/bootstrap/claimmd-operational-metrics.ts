import { Counter, Gauge, type Registry } from "prom-client";

export type ClaimMdWorker = "response_capture" | "identity_resolution" | "ack_dispatch" | "era_capture" | "era_resolution" | "era_delivery" | "financial_safety";
type Summary = object;
export interface ClaimMdDurableMetric {
  readonly worker: ClaimMdWorker;
  readonly measure: string;
  readonly value: number;
}
export type ClaimMdDurableSampler = () => Promise<readonly ClaimMdDurableMetric[]>;

/** Bounded aggregate Claim.MD telemetry. Labels are fixed enums; identifiers and vendor text are never labels. */
export function registerClaimMdOperationalMetrics(registry: Registry, durableSampler?: ClaimMdDurableSampler) {
  const ticks = new Counter({ name: "chartwarden_claimmd_worker_ticks_total", help: "Claim.MD worker ticks by bounded outcome",
    labelNames: ["worker", "outcome"], registers: [registry] });
  const work = new Gauge({ name: "chartwarden_claimmd_work_items", help: "Latest bounded worker backlog or batch counts",
    labelNames: ["worker", "measure"], registers: [registry] });
  const lastSuccess = new Gauge({ name: "chartwarden_claimmd_worker_last_success_timestamp_seconds",
    help: "Unix time of the last successful Claim.MD worker tick", labelNames: ["worker"], registers: [registry] });
  const WORKERS = new Set<ClaimMdWorker>(["response_capture", "identity_resolution", "ack_dispatch", "era_capture", "era_resolution", "era_delivery", "financial_safety"]);
  const MEASURES = new Set([
    "cursor_present", "cursor_age_seconds", "last_success_timestamp_seconds", "stream_failure", "lease_active",
    "inbox_captured", "inbox_needs_review", "inbox_malformed", "resolution_pending", "resolution_resolved",
    "resolution_unmatched", "resolution_ambiguous", "resolution_conflict", "resolution_needs_review",
    "ack_pending", "ack_complete", "ack_needs_review", "ack_applied", "ack_informational", "ack_held",
    "unresolved_events", "applied_events", "oldest_pending_age_seconds",
    "financial_held_duplicate", "financial_failed", "manual_review_unmatched_lines", "financial_oldest_review_age_seconds",
    "capture_discovered", "capture_retryable_failure", "capture_retry_exhausted", "resolution_verified",
    "resolution_unmatched", "resolution_ambiguous", "resolution_conflict", "delivery_prepared", "delivery_held",
    "delivery_delivered", "delivery_possible_duplicate", "delivery_exact_duplicate", "oldest_pending_age_seconds",
  ]);
  let durableHealthy!: Gauge;
  let durableCache: readonly ClaimMdDurableMetric[] = [];
  let durableCacheAt = 0;
  let durableCacheHealthy = false;
  let durableInFlight: Promise<readonly ClaimMdDurableMetric[]> | undefined;
  const durable = new Gauge({ name: "chartwarden_claimmd_durable_work_items",
    help: "Durable Claim.MD pipeline counts and age measures from authoritative storage",
    labelNames: ["worker", "measure"], registers: [registry], async collect() {
      if (!durableSampler) return;
      try {
        for (const worker of WORKERS) for (const measure of MEASURES)
          this.set({ worker, measure }, 0);
        if (Date.now() - durableCacheAt >= 30_000) {
          durableInFlight ??= durableSampler().then((rows) => {
            durableCache = rows;
            durableCacheAt = Date.now();
            durableCacheHealthy = true;
            return rows;
          }).finally(() => { durableInFlight = undefined; });
          await durableInFlight;
        }
        const rows = durableCache;
        for (const row of rows) {
          if (Number.isFinite(row.value) && row.value >= 0 && WORKERS.has(row.worker) && MEASURES.has(row.measure))
            this.set({ worker: row.worker, measure: row.measure }, row.value);
        }
        durableHealthy.set(durableCacheHealthy ? 1 : 0);
      } catch {
        // Scrape failures are observable without exposing database/vendor errors or disrupting API work.
        durableCacheAt = Date.now();
        durableCacheHealthy = false;
        durableHealthy.set(0);
      }
    } });
  durableHealthy = new Gauge({ name: "chartwarden_claimmd_durable_metrics_read_success",
    help: "Whether the latest Claim.MD durable metrics sample completed", registers: [registry] });
  durableHealthy.set(0);
  const count = (summary: Summary, ...keys: string[]): number | undefined => {
    const values = summary as Record<string, unknown>;
    for (const key of keys) if (typeof values[key] === "number" && Number.isFinite(values[key])) return values[key] as number;
    return undefined;
  };
  return { record(worker: ClaimMdWorker, summary: Summary) {
    const values = summary as Record<string, unknown>;
    const code = typeof values.code === "string" ? values.code : undefined;
    const failed = (count(summary, "failed", "failures") ?? 0) > 0 || (code !== undefined && code !== "OK");
    const outcome = failed ? "failure" : "success";
    ticks.inc({ worker, outcome });
    if (!failed) lastSuccess.set({ worker }, Date.now() / 1000);
    const mappings: ReadonlyArray<readonly [string, string[]]> = [
      ["backlog", ["pending", "backlog", "discovered"]], ["processed", ["processed", "examined", "events", "recorded"]],
      ["failed", ["failed", "failures"]], ["held", ["held", "needsReview", "ambiguous", "conflict"]],
      ["resolved", ["resolved", "verified"]],
    ];
    for (const [measure, keys] of mappings) { const value = count(summary, ...keys); if (value !== undefined) work.set({ worker, measure }, value); }
    const age = count(summary, "oldestUnresolvedSeconds", "oldestPendingSeconds");
    if (age !== undefined) work.set({ worker, measure: "oldest_age_seconds" }, age);
  } };
}

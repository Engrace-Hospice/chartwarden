// apps/backend/src/modules/36-messaging/delivery/wiring.ts — GAP-101: M36's delivery-sweep platform job id.
// The send_* sweeps enumerate active orgs under `withPlatformContext`; the id must be on the
// `@chartwarden/tenancy` allowlist (empty -> fail-closed) for the enumerator to be admitted.
import { registerPlatformJob } from "@chartwarden/tenancy";

export const M36_DELIVERY_PLATFORM_JOB_ID = "m36.delivery_sweep";

/** WP 1.9 — the nightly hash_verify / weekly retention_scan active-org fan-out. */
export const M36_INTEGRITY_PLATFORM_JOB_ID = "m36.integrity_jobs";

/** WP 4.9 (ADR-0076) — the supervisor-queue gauges' active-org list read (a scrape, not a sweep): its own audited job id. */
export const M36_ACK_QUEUE_METRICS_PLATFORM_JOB_ID = "m36.ack_queue_metrics";

export function wireM36DeliveryTenancy(): void {
  registerPlatformJob(M36_DELIVERY_PLATFORM_JOB_ID);
  registerPlatformJob(M36_INTEGRITY_PLATFORM_JOB_ID);
  registerPlatformJob(M36_ACK_QUEUE_METRICS_PLATFORM_JOB_ID);
}

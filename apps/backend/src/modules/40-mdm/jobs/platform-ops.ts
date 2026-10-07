// apps/backend/src/modules/40-mdm/jobs/platform-ops.ts — the org-less PLATFORM-OPS notice path M40's scheduled
// scans need (GAP-173). The spec says duplicates and aged provisionals "escalate to platform-ops", but M36's
// AlertEmitter is inherently tenant-scoped (`emit(orgId, ...)`) and platform-ops is not a tenant: forcing it
// through an org would fabricate a scope. The honest shape is the one `bootstrap/dlq-alerts.ts` already set for
// ops-level failures:
//   1. DURABLE — an org-less platform audit event through the migration-0187 `audit_writer_insert_platform_event`
//      writer, so "we told platform-ops" is reconstructable from the audit trail; and
//   2. LIVE — an injected sink (the composition root binds log + the optional `OPS_ALERT_WEBHOOK_URL` webhook).
// The durable write is attempted FIRST and a failure propagates (the cron retries/DLQs); the sink is best-effort
// and must never throw into the caller (a notice failure is not a second failure of the scan).
import type { DbClient } from "@wardenx/db";
import { sql } from "drizzle-orm";

export interface PlatformOpsNotice {
  /** Stable machine kind, e.g. `mdm.duplicate_suspected`, `mdm.provisional_aged`. */
  readonly kind: string;
  /** One human line. No PHI: ids, kinds, counts, ages only. */
  readonly summary: string;
  readonly details: Readonly<Record<string, unknown>>;
  /** Dedupe/trace key (also the audit correlation id). */
  readonly correlationId: string;
}

/** The live ops sink (log / webhook) — bound at the composition root. */
export type PlatformOpsSink = (notice: PlatformOpsNotice) => void;

export interface PlatformOpsDeps {
  readonly db: DbClient;
  readonly sink: PlatformOpsSink;
}

/** Record the notice durably (org-less audit) and hand it to the live sink. */
export async function notifyPlatformOps(
  deps: PlatformOpsDeps,
  notice: PlatformOpsNotice,
): Promise<void> {
  await deps.db.execute(sql`
    SELECT audit_writer_insert_platform_event(
      ${notice.kind}, ${"mdm"}, ${null}::uuid,
      ${"success"}, ${"warn"}, ${notice.correlationId},
      ${JSON.stringify({ summary: notice.summary, ...notice.details })}::jsonb,
      ${"compliance"}
    )
  `);
  try {
    deps.sink(notice);
  } catch {
    // Best-effort by contract: the durable audit row above is the record; a sink failure must not fail the scan.
  }
}

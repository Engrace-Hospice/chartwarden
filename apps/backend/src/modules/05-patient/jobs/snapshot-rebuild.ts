// apps/backend/src/modules/05-patient/jobs/snapshot-rebuild.ts — the quarterly PrivacyFlag snapshot rebuild
// (M5 §4.5 `patient.snapshot_rebuild`: "scheduled (quarterly) + manual via admin route | full rebuild of
// `patient_privacy_flag_snapshot` from Module 39 history; reconciles any drift"; D3 "quarterly full rebuild
// job reconciles drift").
//
// SCOPE — "full rebuild": every patient of the org is re-derived, not only the stale or flagged ones (drift
// is exactly the case where the snapshot does not know it is wrong — e.g. a missed `m39.consent.*` delivery
// left a patient with NO row while M39 holds an expired Part 2 release). The derivation is the officer
// resync's own (`rederivePrivacySnapshot` → `decideResync`): M39's Part 2 state decides `sud`; with M39
// silent the DocLens detections still in force are re-applied and a DocLens flag is never lifted; other
// categories round-trip; a stale snapshot is cleared. Unlike the resync, only DRIFTED rows are written
// (`snapshotNeedsWrite`), so a re-run is a no-op — idempotent, no M4 audit churn, and
// `m5.patient.privacy_flag_changed` only on a real flag-set change.
//
// BATCHING — patients are paged by id (keyset, `pageSize` per read transaction) and each patient's write is
// its OWN `withOrgContext` transaction, so a large org never holds one giant transaction or lock set. One
// patient's failure does not stop the rest; the org's failures are re-raised together at the end (BullMQ
// retries the run; the re-run skips everything already reconciled).
//
// ORG-EXPLICIT — a cron tick is not a request: the job passes `organizationId` explicitly, runs as the
// system (`userId: ""`, audited as system by the M4 trigger), and the fan-out enumerates orgs through the
// audited platform enumerator. The manual admin route runs the same per-org rebuild as the acting officer.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, asc, eq, gt } from "drizzle-orm";
import type { M5OutboxPort } from "../deceased-db";
import type { PrivacyOfficerPorts } from "../privacy/officer";
import { rederivePrivacySnapshot } from "../privacy/officer-db";

/** Patients read per page (one short read transaction per page; writes are per patient). */
export const SNAPSHOT_REBUILD_PAGE_SIZE = 200;

/** The run summary — counts only (no patient ids, no flags: the summary is logged). */
export interface SnapshotRebuildSummary {
  readonly organizationId: string;
  /** Patients re-derived. */
  readonly patients: number;
  /** Snapshot rows written (drift reconciled, or a stale row cleared). */
  readonly rewritten: number;
  /** Rows whose flag SET changed (each emitted `m5.patient.privacy_flag_changed`). */
  readonly flagsChanged: number;
  /** Rows that were stale before the run. */
  readonly staleCleared: number;
  /** Patients whose snapshot already matched its sources (untouched). */
  readonly unchanged: number;
  /** Patients whose re-derivation threw (re-raised after the org's pass). */
  readonly failed: number;
}

export interface SnapshotRebuildDeps {
  readonly outbox: M5OutboxPort;
  readonly ports: Pick<PrivacyOfficerPorts, "consent" | "intake">;
  /** The acting user: `""` (system) for the scheduled job, the officer for the manual route. */
  readonly actorUserId?: string;
  readonly pageSize?: number;
  readonly now?: () => Date;
}

/** Thrown after an org's pass when any patient's re-derivation failed (carries the counts). */
export class SnapshotRebuildPartialFailure extends AggregateError {
  constructor(
    errors: unknown[],
    readonly summary: SnapshotRebuildSummary,
  ) {
    super(
      errors,
      `M5_SNAPSHOT_REBUILD: ${summary.failed} of ${summary.patients} patient(s) failed in org ${summary.organizationId}`,
    );
    this.name = "SnapshotRebuildPartialFailure";
  }
}

/**
 * Rebuild every patient's privacy snapshot in ONE org (M5 §4.5). See the file header for scope, batching
 * and idempotency. Throws {@link SnapshotRebuildPartialFailure} after the pass if any patient failed.
 */
export async function rebuildPrivacySnapshotsForOrg(
  db: DbClient,
  organizationId: string,
  deps: SnapshotRebuildDeps,
): Promise<SnapshotRebuildSummary> {
  const P = schema.patients;
  const pageSize = deps.pageSize ?? SNAPSHOT_REBUILD_PAGE_SIZE;
  const errors: unknown[] = [];
  let patients = 0;
  let rewritten = 0;
  let flagsChanged = 0;
  let staleCleared = 0;
  let unchanged = 0;
  let after: string | null = null;
  for (;;) {
    const cursor: string | null = after;
    const page: { id: string }[] = await withOrgContext(
      db,
      { organizationId, userId: "" },
      async (scoped) =>
        (scoped as unknown as DbClient)
          .select({ id: P.id })
          .from(P)
          .where(
            and(
              eq(P.organizationId, organizationId),
              cursor === null ? undefined : gt(P.id, cursor),
            ),
          )
          .orderBy(asc(P.id))
          .limit(pageSize),
    );
    for (const { id } of page) {
      patients++;
      try {
        const out = await rederivePrivacySnapshot(db, deps.outbox, deps.ports, {
          organizationId,
          patientId: id,
          actorUserId: deps.actorUserId ?? "",
          onlyWhenDrifted: true,
          now: deps.now?.(),
        });
        if (!out || !out.written) {
          unchanged++;
          continue;
        }
        rewritten++;
        if (out.eventEmitted) flagsChanged++;
        if (out.wasStale) staleCleared++;
      } catch (error) {
        errors.push(error);
      }
    }
    if (page.length < pageSize) break;
    after = page[page.length - 1]?.id ?? null;
  }
  const summary: SnapshotRebuildSummary = {
    organizationId,
    patients,
    rewritten,
    flagsChanged,
    staleCleared,
    unchanged,
    failed: errors.length,
  };
  if (errors.length) throw new SnapshotRebuildPartialFailure(errors, summary);
  return summary;
}

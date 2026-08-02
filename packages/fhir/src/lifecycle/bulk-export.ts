// @wardenx/fhir — §2.2 `fhir_bulk_export_job` state machine (M28-T01).
//
// The §2.2 async-export diagram as a PURE function. The worker (M28-T07 `bulk-export-worker.ts`) walks a
// job accepted → in_progress → completed; the sweeper (`bulk-export-sweeper.ts`) walks completed →
// expired at the 24h TTL and purges MinIO; a worker error or a client DELETE reaches failed / cancelled.
//
// ONE INVARIANT THIS FILE GUARDS beyond the edge set: at most one job per client may sit in an ACTIVE
// status (`accepted` or `in_progress`) — the §2.5 Valkey lock backstop. A second `$export` while one is
// active is `429 Too Many Requests`, so `FHIR_BULK_EXPORT_ACTIVE_STATUSES` (in `@wardenx/types`) is the
// set the submission gate counts, and `isFhirBulkExportActive` is the predicate it counts with.

import {
  FHIR_BULK_EXPORT_ACTIVE_STATUSES,
  type FhirBulkExportStatus,
  type FhirStatusTransition,
} from "@wardenx/types";

/** The status a newly-accepted job lands in (§2.2 "POST /$export returns 202"). */
export const FHIR_BULK_EXPORT_INITIAL_STATUS: FhirBulkExportStatus = "accepted";

/** The terminal statuses — no edge leaves them. */
export const FHIR_BULK_EXPORT_TERMINAL_STATUSES: readonly FhirBulkExportStatus[] = [
  "expired",
  "failed",
  "cancelled",
];

export const FHIR_BULK_EXPORT_TRANSITIONS: readonly FhirStatusTransition<FhirBulkExportStatus>[] = [
  {
    fromStatus: null,
    toStatus: "accepted",
    auditAction: "m28.fhir.bulk_export.accepted",
    label: "POST /$export → 202",
  },
  {
    fromStatus: "accepted",
    toStatus: "in_progress",
    auditAction: "m28.fhir.bulk_export.started",
    label: "worker picks up",
  },
  {
    fromStatus: "in_progress",
    toStatus: "completed",
    auditAction: "m28.fhir.bulk_export.completed",
    label: "worker completes per resource type; output URLs minted",
  },
  {
    fromStatus: "completed",
    toStatus: "expired",
    auditAction: "phi.export_artifact_purged",
    label: "24h elapse; NDJSON purged from MinIO",
  },
  {
    fromStatus: "accepted",
    toStatus: "cancelled",
    auditAction: "m28.fhir.bulk_export.cancelled",
    label: "DELETE /$export-poll-status/{id} before pickup",
  },
  {
    fromStatus: "in_progress",
    toStatus: "cancelled",
    auditAction: "m28.fhir.bulk_export.cancelled",
    label: "DELETE /$export-poll-status/{id} mid-run",
  },
  {
    fromStatus: "in_progress",
    toStatus: "failed",
    auditAction: "m28.fhir.bulk_export.failed",
    label: "worker error",
  },
];

/** Resolve the transition for a (from, to) pair, or `null` if the FSM forbids it. */
export function fhirBulkExportTransition(
  from: FhirBulkExportStatus | null,
  to: FhirBulkExportStatus,
): FhirStatusTransition<FhirBulkExportStatus> | null {
  return FHIR_BULK_EXPORT_TRANSITIONS.find((t) => t.fromStatus === from && t.toStatus === to) ?? null;
}

/** True when the FSM permits the transition. Fails CLOSED. */
export function canFhirBulkExportTransition(
  from: FhirBulkExportStatus | null,
  to: FhirBulkExportStatus,
): boolean {
  return fhirBulkExportTransition(from, to) !== null;
}

/** True when a job holds the per-client concurrency lock (§2.5) — the submission gate refuses a second
 *  `$export` while any of the client's jobs is in one of these statuses. */
export function isFhirBulkExportActive(status: FhirBulkExportStatus): boolean {
  return (FHIR_BULK_EXPORT_ACTIVE_STATUSES as readonly FhirBulkExportStatus[]).includes(status);
}

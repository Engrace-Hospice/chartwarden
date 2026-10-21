// @chartwarden/fhir — bulk-export worker + sweeper decision core (§2.2, §D4, W-FHIR-04, M28-T07).
//
// T01 fixed the `fhir_bulk_export_job` FSM edges (`./bulk-export`). This core is the PURE computation the
// T08 worker (`bulk-export-worker.ts`) and sweeper (`bulk-export-sweeper.ts`) wrap with the real IO — the
// consumed-seam reads, the R4 mapping, the per-row consent gate, the MinIO puts, and the Drizzle writes:
//
//   • `bulkExportObjectKey`   — the deterministic MinIO object path (§D4 layout) per resource type.
//   • `planBulkExportArtifact`— one NDJSON file's descriptor: serialized body, row count, sha256 checksum
//                               (the `fhir_bulk_export_artifact.checksum_sha256`), and its object key.
//   • `computeBulkExportCompletion` — the completion roll-up: `total_resources`, `artifact_count`, and the
//                               SERVER-GENERATED `expires_at = completed_at + 24h` (§2.3 "never client-
//                               influenced"). Time is INJECTED as `completedAtMs`; no wall clock here.
//   • `isBulkExportExpired`   — the sweeper predicate: a `completed` job whose `expires_at` has passed
//                               moves to `expired` and its MinIO objects are purged (§2.2).
//
// Determinism matters: two runs over the same rows produce byte-identical NDJSON and therefore identical
// checksums, so a consumer can verify the `X-Checksum-SHA256` header against a re-projection (W-FHIR-04
// step 6). Object keys never embed a wall clock for the same reason.

import { createHash } from "node:crypto";

import {
  FHIR_BULK_EXPORT_TTL_HOURS,
  type FhirBulkExportJobId,
  type FhirBulkExportRequestKind,
  type FhirClientId,
} from "@chartwarden/types";

import type { M28OutboxEvent } from "../outbox-events";

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * §D4 — the MinIO object key for one resource type's NDJSON file:
 * `tenants/<org>/fhir-exports/<job_id>/<resource_type>.ndjson`. Per-tenant prefix so a presigned URL can
 * never cross the org's bucket scope; one file per resource type per the Bulk Data 2.0.0 manifest shape.
 */
export function bulkExportObjectKey(
  organizationId: string,
  jobId: FhirBulkExportJobId,
  resourceType: string,
): string {
  return `tenants/${organizationId}/fhir-exports/${jobId}/${resourceType}.ndjson`;
}

/**
 * Serialize projected resources to newline-delimited JSON (one resource per line, trailing newline) — the
 * Bulk Data 2.0.0 wire format. An empty resource set yields the empty string (no file line), and the
 * caller decides whether a zero-row resource type still gets an artifact row.
 */
export function serializeNdjson(resources: readonly unknown[]): string {
  if (resources.length === 0) return "";
  return `${resources.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

/** The checksum an artifact row records — sha256 (hex) of the NDJSON body, the `X-Checksum-SHA256` header
 *  value the consumer verifies (W-FHIR-04 step 6). */
export function ndjsonChecksum(ndjson: string): string {
  return createHash("sha256").update(ndjson, "utf8").digest("hex");
}

/** One `fhir_bulk_export_artifact` row the worker persists for a resource type — where the NDJSON lives,
 *  how many rows it holds, and its checksum. */
export interface BulkExportArtifactPlan {
  readonly resourceType: string;
  readonly objectKey: string;
  readonly ndjson: string;
  readonly rowCount: number;
  readonly checksumSha256: string;
}

/** §D4 — plan the artifact for one resource type: serialize, count, checksum, and locate. The worker puts
 *  `ndjson` at `objectKey` in MinIO and writes the `fhir_bulk_export_artifact` row from the rest. */
export function planBulkExportArtifact(
  organizationId: string,
  jobId: FhirBulkExportJobId,
  resourceType: string,
  resources: readonly unknown[],
): BulkExportArtifactPlan {
  const ndjson = serializeNdjson(resources);
  return {
    resourceType,
    objectKey: bulkExportObjectKey(organizationId, jobId, resourceType),
    ndjson,
    rowCount: resources.length,
    checksumSha256: ndjsonChecksum(ndjson),
  };
}

/** The completion roll-up the worker writes on the `in_progress → completed` edge. */
export interface BulkExportCompletion {
  readonly totalResources: number;
  readonly artifactCount: number;
  /** `completed_at + 24h`, in epoch-ms and ISO — server-generated, never client-influenced (§2.3). */
  readonly expiresAtMs: number;
  readonly expiresAtIso: string;
}

/**
 * §2.3 — compute the completion roll-up from the persisted artifacts and the injected completion instant.
 * `total_resources` sums every artifact's row count; `artifact_count` is the number of files; `expires_at`
 * is exactly 24 hours after completion (`FHIR_BULK_EXPORT_TTL_HOURS`).
 */
export function computeBulkExportCompletion(
  artifacts: readonly Pick<BulkExportArtifactPlan, "rowCount">[],
  completedAtMs: number,
): BulkExportCompletion {
  const expiresAtMs = completedAtMs + FHIR_BULK_EXPORT_TTL_HOURS * MS_PER_HOUR;
  return {
    totalResources: artifacts.reduce((sum, a) => sum + a.rowCount, 0),
    artifactCount: artifacts.length,
    expiresAtMs,
    expiresAtIso: new Date(expiresAtMs).toISOString(),
  };
}

/**
 * §2.2 — the sweeper predicate: a `completed` job whose `expires_at` is at or before `nowMs` is due to move
 * to `expired` (and its MinIO objects purged). Any non-`completed` status is never swept by TTL — a
 * `failed`/`cancelled`/`accepted`/`in_progress` job is not TTL-eligible. Fails CLOSED (no `expires_at` ⇒
 * not expired).
 */
export function isBulkExportExpired(
  job: { readonly status: string; readonly expiresAtMs: number | null | undefined },
  nowMs: number,
): boolean {
  return job.status === "completed" && job.expiresAtMs != null && job.expiresAtMs <= nowMs;
}

// ── outbox + alert descriptors the worker/route emits at each edge (§2.4, §4.9, §4.10) ────────────────

/** The subset of §4.9 M36 alert intents the bulk-export lifecycle constructs. The real M36 envelope +
 *  recipient resolver are wired in T08's boot (M28 owns no delivery code — §4.9). */
export type BulkExportAlert =
  | {
      kind: "fhir.bulk_export.accepted";
      jobId: FhirBulkExportJobId;
      clientId: FhirClientId;
      resourceTypes: string[];
      initiatedBy: string | null;
    }
  | {
      kind: "fhir.bulk_export.completed";
      jobId: FhirBulkExportJobId;
      clientId: FhirClientId;
      totalResources: number;
      artifactCount: number;
      pollUrl: string;
    }
  | {
      kind: "fhir.bulk_export.failed";
      jobId: FhirBulkExportJobId;
      clientId: FhirClientId;
      failureReason: string;
    };

export function bulkExportAcceptedEvent(args: {
  jobId: FhirBulkExportJobId;
  clientId: FhirClientId;
  resourceTypes: string[];
  requestKind: FhirBulkExportRequestKind;
}): Extract<M28OutboxEvent, { type: "m28.fhir.bulk_export.accepted" }> {
  return { type: "m28.fhir.bulk_export.accepted", payload: { ...args } };
}

export function bulkExportCompletedEvent(args: {
  jobId: FhirBulkExportJobId;
  clientId: FhirClientId;
  completedAt: string;
  totalResources: number;
  artifactCount: number;
}): Extract<M28OutboxEvent, { type: "m28.fhir.bulk_export.completed" }> {
  return { type: "m28.fhir.bulk_export.completed", payload: { ...args } };
}

export function bulkExportFailedEvent(args: {
  jobId: FhirBulkExportJobId;
  clientId: FhirClientId;
  failedAt: string;
  failureReason: string;
}): Extract<M28OutboxEvent, { type: "m28.fhir.bulk_export.failed" }> {
  return { type: "m28.fhir.bulk_export.failed", payload: { ...args } };
}

export function bulkExportCancelledEvent(args: {
  jobId: FhirBulkExportJobId;
  clientId: FhirClientId;
  cancelledByMembershipId: string | null;
  cancelledAt: string;
}): Extract<M28OutboxEvent, { type: "m28.fhir.bulk_export.cancelled" }> {
  return { type: "m28.fhir.bulk_export.cancelled", payload: { ...args } };
}

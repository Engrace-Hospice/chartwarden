// apps/backend/src/modules/22-documents/domain/effects.ts — M22-T03 (§2.4, §2.5, §2.6).
//
// The M6/M17/M18 §2.4 pattern: every document-lifecycle transition carries an explicit, in-transaction
// side-effect list (the row insert/flip + the M4 write-audit + the outbox event + the read-audit access-log
// row), and the COMMIT binds the `document` / `document_version` / `document_access_log` row, the audit row and
// the outbox row atomically — the "DB updated but the event never went out" failure mode is eliminated
// structurally (M1 §25.5/§25.6). This pure domain returns side effects DECLARATIVELY as data; the service
// layer (M22-T07) executes them inside one transaction. Keeping them as data makes the domain deterministic
// and unit-testable with no DB, no MinIO, no clock. `outbox` events are restricted to the §4.10 `m22.*`
// catalog (the dispatcher + the M22-T06 outbox registration validate the wire names).
import type { DocumentAccessKind, DocumentRetentionClass, DocumentStatus, M22EventName } from "@wardenx/types";

/**
 * One in-transaction (or, for alerts, fire-and-forget) side effect a document-lifecycle transition declares
 * (§2.4). The service layer (M22-T07) is the only place these run; the pure domain never touches IO. The
 * MinIO / DEK operations are declared as INTENTS here (the eraseFn wiring lands in M22-T10).
 */
export type DocumentSideEffect =
  /** Write the M4 write-audit row for the mutating operation (always present per §2.5 / §3.6 denylist). */
  | { readonly kind: "audit" }
  /** Publish an `m22.*` outbox event in the same tx (§4.10 catalog). */
  | { readonly kind: "outbox"; readonly event: M22EventName }
  /** §2.4 — insert a §2.2.2 append-only `document_version` row carrying the resolved opaque MinIO object key. */
  | { readonly kind: "insert_version"; readonly minioObjectKey: string; readonly versionNumber: number }
  /** §2.2.1 / §2.2.2 — flip `document.active_version_id` to the just-inserted version (the single source of
   * "current version"; there is no per-version is_current flag, F19). */
  | { readonly kind: "set_active_version" }
  /** §2.2.1 — transition `document.status` (active ↔ legal_hold, → superseded, → destroyed_tombstone). */
  | { readonly kind: "set_status"; readonly status: DocumentStatus }
  /** §2.3 — apply a validated retention-class change (`clinical_record → compliance` upgrade only). */
  | { readonly kind: "set_retention_class"; readonly retentionClass: DocumentRetentionClass }
  /** §2.4 — insert a `document_legal_hold` row (status flips to `legal_hold`; one active hold per document). */
  | { readonly kind: "insert_legal_hold" }
  /** §2.4 — stamp `document_legal_hold.released_at` on the active hold (status flips back to `active`). */
  | { readonly kind: "release_legal_hold" }
  /** §2.4 / §7.9 / §7.10 — append a §164.528 `document_access_log` row for a read / signed-URL event. */
  | { readonly kind: "insert_access_log"; readonly accessKind: DocumentAccessKind }
  /** §2.4 / §7.14 D12 — version-aware MinIO delete of ALL object versions + delete markers for every
   * `document_version.minio_object_key` (DR-019 / ARCH-085; the executor lands in M22-T10). */
  | { readonly kind: "delete_minio_object_versions" }
  /** §2.4 / §7.14 D12 — cryptographically shred the per-tenant DEK for the version cipher columns. */
  | { readonly kind: "shred_version_dek" }
  /** §2.2.1 / §7.14 — null `document.active_version_id` as part of the tombstone (the row is preserved for
   * FK integrity from cross-module rows that still hold the `document_id`, §2.2.1). */
  | { readonly kind: "null_active_version" }
  /** §2.4 — re-point `document.patient_id` to the resolved `merged_into_id` terminal (the `patient.merged`
   * cascade is the only permitted patient-binding change, §2.3). */
  | { readonly kind: "repoint_patient"; readonly patientId: string };

/** Collect the outbox event names a side-effect list declares, order-preserving (test/assembly helper). */
export function outboxEvents(effects: readonly DocumentSideEffect[]): M22EventName[] {
  return effects
    .filter((e): e is Extract<DocumentSideEffect, { kind: "outbox" }> => e.kind === "outbox")
    .map((e) => e.event);
}

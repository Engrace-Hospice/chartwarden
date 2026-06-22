// apps/backend/src/modules/22-documents/domain/document-lifecycle.ts — M22-T03 (§2.2.1, §2.2.2, §2.3, §2.4).
//
// The PURE §2.2.1 document aggregate state machine + the §2.2.2 append-only version ledger. A `document` has
// four states (`active` ⇄ `legal_hold`, `→ superseded`, `→ destroyed_tombstone`); a `document_version` has no
// state of its own — versions are append-only and the `document.active_version_id` pointer is the single source
// of "current version" (F19; there is no per-version is_current flag). So this is a validated factory + a small
// transition machine, not a per-version state graph: it runs the §2.3 guards, then returns the §2.4 side-effect
// list DECLARATIVELY (audit + outbox + the row insert/flip). No IO, no MinIO, no DB, no clock — fully
// unit-testable. The service / route layer (M22-T07) loads context under RLS, mints ids + the opaque MinIO key
// (via `object-storage`), and executes the effects in one transaction.
import type { DocumentRetentionClass, DocumentSourceKind, DocumentStatus } from "@wardenx/types";
import type { DocumentSideEffect } from "./effects";
import { assertRetentionClassChange } from "./retention";
import { require_ } from "./errors";

/** §2.2.2 — the version-creator shape shared by `createDocument` (v1) and `addVersion` (vN, n≥2). */
export interface VersionInput {
  /** App-side serial within the document; v1 = 1, strictly increasing thereafter (§2.3 monotonicity). */
  readonly versionNumber: number;
  /** The opaque, tenant-prefixed MinIO object key (built by `object-storage.renderedObjectKey`). */
  readonly minioObjectKey: string;
  /** Lowercase hex SHA-256 of the stored bytes; never updated post-insert (§2.3 sha256 immutability). */
  readonly sha256Hex: string;
  readonly mimeType: string;
  /** `user` | `system_render` | `api` | `portal` | `fax` — gates the uploader-shape CHECK (§2.3). */
  readonly uploadedByKind: string;
  /** Present iff `uploadedByKind === 'user'` (the §2.3 uploader-shape rule, DB CHECK mirror). */
  readonly uploadedByMembershipId: string | null;
  /** §2.2.2 — set on a correction version (points at the version it amends); null for a plain new version. */
  readonly replacesVersionId?: string | null;
}

function assertVersionShape(version: VersionInput): void {
  require_(
    version.sha256Hex.trim().length > 0,
    "DOCUMENT_SHA256_REQUIRED",
    "every document_version requires a non-empty sha256_hex at insert.",
  );
  require_(
    version.minioObjectKey.trim().length > 0,
    "DOCUMENT_OBJECT_KEY_REQUIRED",
    "every document_version requires the opaque tenant-prefixed minio_object_key.",
  );
  require_(
    (version.uploadedByKind === "user") === (version.uploadedByMembershipId !== null),
    "DOCUMENT_UPLOADER_SHAPE_INVALID",
    "(uploaded_by_kind = 'user') must equal (uploaded_by_membership_id IS NOT NULL).",
  );
}

/** The deterministic result of a lifecycle transition: the resulting status + the §2.4 effects. */
export interface DocumentTransitionResult {
  readonly status: DocumentStatus;
  readonly effects: readonly DocumentSideEffect[];
}

/**
 * §2.2.1 — create a document at its first version: validate the v1 shape, then declare the §2.4 effects (insert
 * the `document` row `active`, insert v1, point `active_version_id` at it, write audit, publish
 * `m22.document.created`). The retention class is set HERE and only here for `compliance_42cfr_part2` (D23).
 */
export function createDocument(input: {
  readonly retentionClass: DocumentRetentionClass;
  readonly sourceKind: DocumentSourceKind;
  readonly firstVersion: VersionInput;
}): DocumentTransitionResult {
  require_(
    input.firstVersion.versionNumber === 1,
    "DOCUMENT_VERSION_NOT_MONOTONIC",
    "the first version of a document must be version_number = 1.",
  );
  assertVersionShape(input.firstVersion);

  const effects: DocumentSideEffect[] = [
    { kind: "audit" },
    {
      kind: "insert_version",
      minioObjectKey: input.firstVersion.minioObjectKey,
      versionNumber: input.firstVersion.versionNumber,
    },
    { kind: "set_active_version" },
    { kind: "outbox", event: "m22.document.created" },
  ];
  return { status: "active", effects };
}

/**
 * §2.2.1 / §2.2.2 — append a new version (n≥2) and flip `active_version_id`. A new version NEVER transitions the
 * document (it stays `active`) — UNLESS `supersedeDocument` is set, the D21 external-source two-PDF case where
 * the pre-cosign document's status becomes `superseded` once the post-cosign version lands. Refuses if the
 * document is tombstoned (terminal) or not in a versionable state, and enforces §2.3 strict monotonicity.
 */
export function addVersion(input: {
  readonly currentStatus: DocumentStatus;
  readonly currentActiveVersionNumber: number;
  readonly newVersion: VersionInput;
  /** D21 — supersede the document (status → `superseded`) as the new version lands (external-source two-PDF). */
  readonly supersedeDocument?: boolean;
}): DocumentTransitionResult {
  require_(input.currentStatus !== "destroyed_tombstone", "DOCUMENT_TOMBSTONED", "a tombstoned document is terminal.");
  require_(
    input.currentStatus === "active" || input.currentStatus === "superseded",
    "DOCUMENT_NOT_VERSIONABLE",
    "a new version may only be added to an active (or superseded, D21) document — not one on legal hold.",
  );
  require_(
    input.newVersion.versionNumber === input.currentActiveVersionNumber + 1,
    "DOCUMENT_VERSION_NOT_MONOTONIC",
    "document_version.version_number must strictly increase by one within a document.",
  );
  assertVersionShape(input.newVersion);

  const status: DocumentStatus = input.supersedeDocument ? "superseded" : "active";
  const effects: DocumentSideEffect[] = [
    { kind: "audit" },
    {
      kind: "insert_version",
      minioObjectKey: input.newVersion.minioObjectKey,
      versionNumber: input.newVersion.versionNumber,
    },
    { kind: "set_active_version" },
    { kind: "outbox", event: "m22.document.versioned" },
  ];
  if (input.supersedeDocument) effects.push({ kind: "set_status", status: "superseded" });
  return { status, effects };
}

/**
 * §2.3 — apply a validated retention-class change (the `clinical_record → compliance` upgrade only; D23 SUD
 * class immutable). Delegates the policy to `assertRetentionClassChange`; declares the row update + audit. A
 * no-op (`from === to`) returns no effects.
 */
export function changeRetentionClass(input: {
  readonly from: DocumentRetentionClass;
  readonly to: DocumentRetentionClass;
}): readonly DocumentSideEffect[] {
  assertRetentionClassChange(input.from, input.to);
  if (input.from === input.to) return [];
  return [{ kind: "audit" }, { kind: "set_retention_class", retentionClass: input.to }];
}

/**
 * §2.4 — apply a legal hold (driven by the M4 `legal_hold.applied` consumer): `active → legal_hold`, insert the
 * `document_legal_hold` row, publish `m22.document.legal_hold_applied`. Refuses if the document is tombstoned or
 * already on hold (the partial-UNIQUE one-active-hold rule).
 */
export function applyLegalHold(input: { readonly currentStatus: DocumentStatus }): DocumentTransitionResult {
  require_(input.currentStatus !== "destroyed_tombstone", "DOCUMENT_TOMBSTONED", "a tombstoned document is terminal.");
  require_(
    input.currentStatus !== "legal_hold",
    "DOCUMENT_ALREADY_ON_LEGAL_HOLD",
    "the document already has an active legal hold.",
  );
  return {
    status: "legal_hold",
    effects: [
      { kind: "audit" },
      { kind: "insert_legal_hold" },
      { kind: "set_status", status: "legal_hold" },
      { kind: "outbox", event: "m22.document.legal_hold_applied" },
    ],
  };
}

/**
 * §2.4 — release a legal hold (driven by the M4 `legal_hold.released` consumer): `legal_hold → active`, stamp
 * `document_legal_hold.released_at`, publish `m22.document.legal_hold_released`. Refuses if the document is not
 * currently on hold.
 */
export function releaseLegalHold(input: { readonly currentStatus: DocumentStatus }): DocumentTransitionResult {
  require_(
    input.currentStatus === "legal_hold",
    "DOCUMENT_NOT_ON_LEGAL_HOLD",
    "the document is not currently on legal hold.",
  );
  return {
    status: "active",
    effects: [
      { kind: "audit" },
      { kind: "release_legal_hold" },
      { kind: "set_status", status: "active" },
      { kind: "outbox", event: "m22.document.legal_hold_released" },
    ],
  };
}

/**
 * §2.2.1 / §7.14 D12 — the pure tombstone transition (`→ destroyed_tombstone`). This is the destruction
 * STATE change only; the eraser orchestration (legal-hold/SUD skip decisions, MinIO version-aware delete, DEK
 * shred sweep across a destruction-cert scope) lands in M22-T10 and consumes `retention.decideDestruction`.
 * Refuses an already-tombstoned document. Declares: version-aware MinIO delete, DEK shred, status flip, null the
 * active-version pointer (the row is PRESERVED for FK integrity, §2.2.1), audit, and `m22.document.tombstoned`.
 * The §164.528 destruction-cert `document_access_log` capture (§7.14 step c) is applied by the M22-T10 eraser
 * — the `access_kind` column is `text` and the T01-locked `document_access_kind` enum carries no `destruction`
 * member, so it is not modelled as a typed `insert_access_log` effect here.
 */
export function tombstoneDocument(input: { readonly currentStatus: DocumentStatus }): DocumentTransitionResult {
  require_(
    input.currentStatus !== "destroyed_tombstone",
    "DOCUMENT_TOMBSTONED",
    "the document is already tombstoned (the transition is idempotent at the service layer, refused here).",
  );
  require_(
    input.currentStatus !== "legal_hold",
    "DOCUMENT_DESTRUCTION_BLOCKED_LEGAL_HOLD",
    "a document under an active legal hold cannot be destroyed (the eraser must skip it, D12).",
  );
  return {
    status: "destroyed_tombstone",
    effects: [
      { kind: "audit" },
      { kind: "delete_minio_object_versions" },
      { kind: "shred_version_dek" },
      { kind: "set_status", status: "destroyed_tombstone" },
      { kind: "null_active_version" },
      { kind: "outbox", event: "m22.document.tombstoned" },
    ],
  };
}

// apps/backend/src/modules/22-documents/domain/errors.ts — M22-T03 (§2.2.1, §2.2.2, §2.3, §7.9, §7.10, §7.14).
//
// Every guard / validation failure in the pure M22 document-lifecycle domain (the §2.2.1 aggregate state
// machine, the §2.2.2 append-only version ledger, the §2.3 validation rules, the §2.4 legal-hold + eraser
// transitions, the §7.10 D11 signed-URL TTL clamp, the §2.4 patient-merge redirect) raises a
// `DocumentStateError` carrying the machine-readable code below. It extends the M1 `WardenXError` envelope
// base (`@wardenx/types` — NOT the banned `packages/foundation`) so the M1 Fastify error handler renders it
// with the precise code + HTTP status with no cross-module import edge (the M6 `AdmissionStateError` / M17
// `SchedulingStateError` / M18 `EvvStateError` convention). Nothing transitions on a string match — each code
// is an enumerated constant; the §2.3 / §3.x DB CHECK + partial-unique backstops (M22-T02 / 0048+0049) repeat
// the strongest of these at the schema layer as defense in depth. The service / route layer (M22-T07) reuses
// these codes verbatim.
import { WardenXError } from "@wardenx/types";

/** The §2.2 / §2.3 document-lifecycle + storage + redirect failure-code catalog → HTTP status. */
export const M22_ERROR_STATUS = {
  // ── §2.2.1 / §2.2.2 version ledger ─────────────────────────────────────────────────────────────────
  // §2.3 — `document_version.version_number` must strictly increase within a document (DB CHECK mirror).
  DOCUMENT_VERSION_NOT_MONOTONIC: 409,
  // §2.3 — every `document_version` requires a non-empty `sha256_hex` at insert (it is never updated post-insert).
  DOCUMENT_SHA256_REQUIRED: 422,
  // §2.3 — `(uploaded_by_kind = 'user') = (uploaded_by_membership_id IS NOT NULL)` (DB CHECK mirror).
  DOCUMENT_UPLOADER_SHAPE_INVALID: 422,
  // §2.3 — `document_version.minio_object_key` must be the opaque, tenant-prefixed key built by `object-storage`.
  DOCUMENT_OBJECT_KEY_REQUIRED: 422,

  // ── §2.2.1 aggregate state machine ─────────────────────────────────────────────────────────────────
  // §2.2.1 — a new version was added to a document not in a versionable state (`active`).
  DOCUMENT_NOT_VERSIONABLE: 409,
  // §2.2.1 — a transition was attempted from a terminal `destroyed_tombstone` document.
  DOCUMENT_TOMBSTONED: 409,
  // §2.2.1 — a legal hold was applied to a document already on hold (the partial-UNIQUE one-active-hold rule).
  DOCUMENT_ALREADY_ON_LEGAL_HOLD: 409,
  // §2.2.1 — a legal-hold release was attempted on a document not currently on hold.
  DOCUMENT_NOT_ON_LEGAL_HOLD: 409,

  // ── §2.3 retention-class consistency ──────────────────────────────────────────────────────────────
  // §2.3 — `retention_class` can only change `clinical_record → compliance` (upgrade), never downgrade.
  DOCUMENT_RETENTION_DOWNGRADE_FORBIDDEN: 409,
  // §2.3 / D23 — `compliance_42cfr_part2` is set at INSERT only and never mutated post-insert (except the M4
  // legal-hold workflow); a service-layer retention change to/from it is refused here.
  DOCUMENT_SUD_RETENTION_IMMUTABLE: 409,

  // ── §2.3 patient binding stability (§2.4 merge redirect) ───────────────────────────────────────────
  // §2.3 — `document.patient_id` may only change via the `patient.merged` cascade (always to `merged_into_id`).
  DOCUMENT_PATIENT_BINDING_IMMUTABLE: 409,
  // §2.4 — the `merged_into_id` resolver did not terminate (a merge cycle in the M5 redirect chain).
  DOCUMENT_MERGE_CHAIN_UNRESOLVED: 409,

  // ── §2.2.1 / §7.14 D12 destruction (eraser pathway — full eraseFn wiring lands in M22-T10) ───────────
  // §2.2.1 / D12 — a destruction was attempted on a document under an active legal hold (eraser must skip it).
  DOCUMENT_DESTRUCTION_BLOCKED_LEGAL_HOLD: 409,
  // D12 / §7.14 — a `compliance_42cfr_part2` document cannot be destroyed during the patient's lifetime
  // (passed through to M4's `eraseAuditRows`, which refuses).
  DOCUMENT_DESTRUCTION_BLOCKED_SUD: 409,

  // ── §7.10 D11 signed-URL TTL clamp ─────────────────────────────────────────────────────────────────
  // §7.10 — a non-positive requested TTL (a signed URL must live for at least one second).
  DOCUMENT_SIGNED_URL_TTL_INVALID: 422,
} as const;

/** A machine-readable M22 document-lifecycle / storage failure code (§2.2 / §2.3). */
export type M22ErrorCode = keyof typeof M22_ERROR_STATUS;

/**
 * A guard / validation failure in the pure M22 document-lifecycle domain. Carries the precise §2.3 `code` so
 * the UI renders an exact message; the M1 error handler maps `statusCode` to the HTTP response. Per §2.2 every
 * guard failure surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class DocumentStateError extends WardenXError {
  constructor(code: M22ErrorCode, message: string) {
    super(code, message, M22_ERROR_STATUS[code]);
    this.name = "DocumentStateError";
  }
}

/** Throw a {@link DocumentStateError} when `condition` is false (guard helper). */
export function require_(condition: boolean, code: M22ErrorCode, message: string): void {
  if (!condition) throw new DocumentStateError(code, message);
}

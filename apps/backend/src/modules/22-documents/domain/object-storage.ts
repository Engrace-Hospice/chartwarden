// apps/backend/src/modules/22-documents/domain/object-storage.ts — M22-T03 (§3.3 D1 storage model, §7.10 D11).
//
// The PURE per-tenant MinIO key model. Two distinct strings live here and they must never be confused:
//
//   1. The INTERNAL storage object key (D1) — `documents/{patientId}/{documentType}/{documentId}/{versionId}.pdf`
//      for rendered output and `intake/{batchId}/...` for intake artifacts, inside the per-tenant bucket
//      `tenant-{tenantId}`. This key is server-internal; it never appears in a URL handed to a client. It is
//      stored on `document_version.minio_object_key` and is DENYLISTED from the §3.6 write-audit (it carries a
//      patient prefix). Per-tenant bucket scoping is what makes bulk-export + bulk-destruction a bucket-level
//      operation (the eraser pathway, §3.7).
//
//   2. The OPAQUE download filename / presigned-URL leaf (D11 / §7.10 / SEC-015) —
//      `{documentType}-{shortVersionId}.pdf`, where `shortVersionId` is a random 12-char token. This is the
//      ONLY key that may appear in a presigned URL or `Content-Disposition` header. It contains NO patient
//      identifier by construction so proxy / CDN / MinIO access logs never capture PHI. The M1 PHI scrubber is
//      a backstop; the opaque pattern is the primary control.
//
// Everything here is a pure, deterministic string function — the random `shortVersionId` is INJECTED by the
// caller (the service layer mints it) so this module stays clock-/RNG-free and unit-testable.
import { require_ } from "./errors";

/** §7.10 D11 — the opaque short-version token length (random `[A-Za-z0-9]{12}`). */
export const SHORT_VERSION_ID_LEN = 12;

/** The per-tenant bucket name (D1: one bucket per tenant → bucket-level bulk export + destruction). */
export function tenantBucket(tenantId: string): string {
  require_(tenantId.trim().length > 0, "DOCUMENT_OBJECT_KEY_REQUIRED", "tenantId is required for the bucket name.");
  return `tenant-${tenantId}`;
}

/** The internal rendered-document object key (D1). Server-internal; patient-prefixed; DENYLISTED (§3.6). */
export function renderedObjectKey(args: {
  readonly patientId: string;
  readonly documentType: string;
  readonly documentId: string;
  readonly versionId: string;
}): string {
  const { patientId, documentType, documentId, versionId } = args;
  require_(
    [patientId, documentType, documentId, versionId].every((p) => p.trim().length > 0),
    "DOCUMENT_OBJECT_KEY_REQUIRED",
    "patientId, documentType, documentId and versionId are all required for the rendered object key.",
  );
  return `documents/${patientId}/${documentType}/${documentId}/${versionId}.pdf`;
}

/** The internal intake-artifact object key (D1). Batch-prefixed (no patient prefix — intake precedes binding). */
export function intakeObjectKey(args: { readonly batchId: string; readonly leaf: string }): string {
  const { batchId, leaf } = args;
  require_(
    batchId.trim().length > 0 && leaf.trim().length > 0,
    "DOCUMENT_OBJECT_KEY_REQUIRED",
    "batchId and leaf are required for the intake object key.",
  );
  return `intake/${batchId}/${leaf}`;
}

/**
 * §7.10 D11 — the opaque presigned-URL leaf / download filename: `{documentType}-{shortVersionId}.pdf`. This is
 * the ONLY storage string allowed into a client-facing URL or `Content-Disposition` header; it is PHI-free by
 * construction. Rejects a malformed short token so a non-opaque (potentially PHI-bearing) leaf can never be
 * minted by accident.
 */
export function opaqueDownloadFilename(documentType: string, shortVersionId: string): string {
  require_(
    /^[a-z0-9_]+$/.test(documentType),
    "DOCUMENT_OBJECT_KEY_REQUIRED",
    "documentType must be a lowercase slug (an enum aggregate type), never free text.",
  );
  require_(
    new RegExp(`^[A-Za-z0-9]{${SHORT_VERSION_ID_LEN}}$`).test(shortVersionId),
    "DOCUMENT_OBJECT_KEY_REQUIRED",
    `shortVersionId must be a random ${SHORT_VERSION_ID_LEN}-char opaque token (no PHI; D11/SEC-015).`,
  );
  return `${documentType}-${shortVersionId}.pdf`;
}

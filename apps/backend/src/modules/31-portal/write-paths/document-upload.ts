// apps/backend/src/modules/31-portal/write-paths/document-upload.ts — M31-T06 (§7.8 / M22 D10).
//
// The portal document-upload write path. M22 OWNS the bytes, the MinIO storage, the intake-extraction
// pipeline (DocLens), virus scan, retention, watermarking (§1.2). M31 streams the upload DIRECTLY to M22's
// intake pre-signed URL — it never holds the bytes (§1.2 (b)). In the reduced 3-table scope M31 owns no
// `portal_document_upload` provenance table either (the manifest owns exactly the three PHI tables — ADR-0005),
// so this core owns only the §7.8 step-1 VALIDATION gate + the outbox-event plan:
//   • byte size ≤ min(50 MB platform floor, tenant cap)         → else UPLOAD_TOO_LARGE (413)
//   • declared MIME ∈ {PDF, JPEG, PNG, HEIC, TIFF}              → else UPLOAD_MIME_NOT_ALLOWED (415)
//   • server-side magic-byte prefix matches the declared MIME   → else UPLOAD_MAGIC_BYTE_MISMATCH (415)
// A clean upload plans `m31.portal_document.upload_started` (at mint) + `m31.portal_document.uploaded` (once
// M22 intake ACKs); a rejected one plans `m31.portal_document.upload_rejected` with a SANITIZED reason (§7.8
// step 7 — never leak internal pipeline detail). All three names are in the T01 `M31_EVENT_NAMES` taxonomy.
//
// PURE: the byte size, declared MIME, and a small magic-byte prefix are passed in; no I/O, no MinIO SDK. The
// route (T07) reads the prefix off the stream and streams the body to M22's presigned URL; this core decides
// accept/reject and which event to emit.
import type { PatientId } from "@wardenx/types";
import { requirePortalWrite } from "./errors";

/** §7.8 / §2.3 — the platform-floor upload size ceiling (50 MB). A tenant may TIGHTEN, never loosen. */
export const PORTAL_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

/** §7.8 / §2.3 — the MIME allowlist. The magic-byte prefixes below are validated against the declared MIME. */
export const PORTAL_UPLOAD_MIME_ALLOWLIST = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/tiff",
] as const;

export type PortalUploadMime = (typeof PORTAL_UPLOAD_MIME_ALLOWLIST)[number];

/** The magic-byte signatures per allowed MIME (first bytes of the file). HEIC's `ftyp` box begins at byte 4,
 *  so it is matched as a substring within the first 12 bytes rather than a strict prefix. */
const MAGIC_PREFIXES: Readonly<Record<PortalUploadMime, readonly number[][]>> = {
  "application/pdf": [[0x25, 0x50, 0x44, 0x46]], // %PDF
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/tiff": [
    [0x49, 0x49, 0x2a, 0x00], // little-endian
    [0x4d, 0x4d, 0x00, 0x2a], // big-endian
  ],
  "image/heic": [], // ftyp box — matched specially below (substring 'ftyp' in the first 12 bytes)
};

/** The §7.8 upload validation input — the caller reads size + declared MIME + a magic-byte prefix off the
 *  stream and passes them here. `magicBytes` is the leading bytes of the file (≥ 12 recommended). */
export interface PortalUploadInput {
  readonly orgId: string;
  readonly patientId: PatientId;
  readonly portalAccountId: string;
  readonly byteSize: number;
  readonly declaredMime: string;
  readonly magicBytes: readonly number[];
  /** §7.6 — true while the patient is in the post-discharge (non-death) read-only grace window. */
  readonly patientDischargedReadOnly: boolean;
  /** Optional tenant-tightened size cap (bytes); clamped to the platform floor. */
  readonly tenantMaxBytes?: number;
}

/** The plan a validated upload produces: the intake descriptor + the two outbox events the route emits. */
export interface PortalUploadPlan {
  readonly orgId: string;
  readonly patientId: PatientId;
  readonly portalAccountId: string;
  readonly mime: PortalUploadMime;
  readonly byteSize: number;
  /** `m31.portal_document.upload_started` (on presigned-URL mint) then `.uploaded` (on M22 ACK). */
  readonly startedEvent: "m31.portal_document.upload_started";
  readonly uploadedEvent: "m31.portal_document.uploaded";
}

function isAllowedMime(mime: string): mime is PortalUploadMime {
  return (PORTAL_UPLOAD_MIME_ALLOWLIST as readonly string[]).includes(mime);
}

/** Does the file's leading bytes match one of the declared MIME's magic signatures? HEIC matches on the
 *  `ftyp` box appearing within the first 12 bytes (its brand follows). */
export function magicBytesMatch(mime: PortalUploadMime, magic: readonly number[]): boolean {
  if (mime === "image/heic") {
    const ftyp = [0x66, 0x74, 0x79, 0x70]; // 'ftyp'
    const window = magic.slice(0, 12);
    for (let i = 0; i + ftyp.length <= window.length; i++) {
      if (ftyp.every((b, j) => window[i + j] === b)) return true;
    }
    return false;
  }
  return MAGIC_PREFIXES[mime].some((sig) => sig.every((b, i) => magic[i] === b));
}

/**
 * Validate a portal document upload (§7.8 step 1) and produce the intake plan — or throw a `PortalWriteError`
 * naming the exact §7.8 negative path. PURE: no I/O. Guard order matches §7.8's negative-path list:
 *   1. discharged-read-only → PATIENT_DISCHARGED_READ_ONLY (§7.6)
 *   2. size                 → UPLOAD_TOO_LARGE (413)
 *   3. MIME allowlist       → UPLOAD_MIME_NOT_ALLOWED (415)
 *   4. magic-byte re-check  → UPLOAD_MAGIC_BYTE_MISMATCH (415)
 */
export function planDocumentUpload(input: PortalUploadInput): PortalUploadPlan {
  requirePortalWrite(
    !input.patientDischargedReadOnly,
    "PATIENT_DISCHARGED_READ_ONLY",
    "This patient was discharged. You retain read access for record review; uploads are disabled.",
  );

  const cap =
    input.tenantMaxBytes !== undefined
      ? Math.min(input.tenantMaxBytes, PORTAL_UPLOAD_MAX_BYTES)
      : PORTAL_UPLOAD_MAX_BYTES;
  requirePortalWrite(
    input.byteSize > 0 && input.byteSize <= cap,
    "UPLOAD_TOO_LARGE",
    `The file is too large. The maximum size is ${Math.floor(cap / (1024 * 1024))} MB.`,
  );

  requirePortalWrite(
    isAllowedMime(input.declaredMime),
    "UPLOAD_MIME_NOT_ALLOWED",
    "That file type is not accepted. Allowed types: PDF, JPEG, PNG, HEIC, TIFF.",
  );
  const mime = input.declaredMime;

  requirePortalWrite(
    magicBytesMatch(mime, input.magicBytes),
    "UPLOAD_MAGIC_BYTE_MISMATCH",
    "The file contents do not match its type. Please re-upload the original file.",
  );

  return {
    orgId: input.orgId,
    patientId: input.patientId,
    portalAccountId: input.portalAccountId,
    mime,
    byteSize: input.byteSize,
    startedEvent: "m31.portal_document.upload_started",
    uploadedEvent: "m31.portal_document.uploaded",
  };
}

/** §7.8 step 7 — the SANITIZED rejection reason surfaced to the caregiver + carried on the
 *  `m31.portal_document.upload_rejected` event. Maps the internal write-error code to a §2.2.5-style bucket;
 *  internal pipeline detail (virus-scanner name, extractor stack) is NEVER leaked. */
export function sanitizedRejectionReason(
  code: "UPLOAD_TOO_LARGE" | "UPLOAD_MIME_NOT_ALLOWED" | "UPLOAD_MAGIC_BYTE_MISMATCH" | "m22_intake_failed",
): "size_limit" | "mime_not_allowed" | "m22_intake_failed" {
  switch (code) {
    case "UPLOAD_TOO_LARGE":
      return "size_limit";
    case "UPLOAD_MIME_NOT_ALLOWED":
    case "UPLOAD_MAGIC_BYTE_MISMATCH":
      return "mime_not_allowed";
    case "m22_intake_failed":
      return "m22_intake_failed";
  }
}

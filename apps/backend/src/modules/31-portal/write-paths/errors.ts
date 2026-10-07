// apps/backend/src/modules/31-portal/write-paths/errors.ts — M31-T06 (§1.1 "the four" / §7.7–§7.9).
//
// The portal has EXACTLY four write surfaces (§1.2: caregiver-attested administration, document upload,
// amendment request, secure message). This task builds the three that mutate the clinical record through an
// upstream module — caregiver-attested administration (M13 D10), document upload (M22 intake), amendment
// request (M5 §164.526). Secure messaging (§1.2 (d)) is M36's existing `messaging.send` route called from
// `apps/portal`; M31 holds no message body, so it has no write core here (only the membership-reconciliation
// outbox signals, already emitted by the T03 grant lifecycle).
//
// Every guard failure raises a `PortalWriteError` carrying the machine-readable code the §7.7–§7.9 negative
// paths name. Same envelope base + SCREAMING_SNAKE dialect as the T03 `PortalStateError` (lifecycle/errors.ts)
// — the two catalogs are disjoint by concern (lifecycle = session/invite/scope/consent; write = the four
// write paths) so a code never means two things. Status codes are spelled VERBATIM where §7 spells them: an
// inactive medication order is `410 Gone` (§7.7), an oversized upload is `413`, a MIME mismatch is `415`.
//
// FAIL DIRECTION: every write guard fails CLOSED — an out-of-window dose, an oversized/wrong-type file, a
// discharged-read-only patient, or a missing attestation produces a refusal, never a default-through. The
// portal is the most consumer-exposed surface (§8); a write that reaches an upstream clinical module must
// have cleared every M31-side precondition first (the upstream module re-validates — defense in depth).
import { WardenXError } from "@wardenx/types";

/** The §7.7–§7.9 write-path failure-code catalog → HTTP status. */
export const M31_WRITE_ERROR_STATUS = {
  // ── §7.7 caregiver-attested medication administration (M13 D10) ───────────────────────────────────────
  /** §7.7 VERBATIM — `410 Gone`. The medication order is no longer active; attesting a dose against a dead
   *  order would write a clinical fact with no live basis. Rendered as "This medication order is no longer
   *  active." A `410` (not `404`) tells the caregiver the order WAS real and is now closed. */
  ORDER_INACTIVE: 410,
  /** §7.7 — the attested dose time is outside the ±2h window around now (form validation; M31 does not send
   *  to M13). A future/stale attestation cannot be trusted as a contemporaneous record. */
  DOSE_TIME_OUT_OF_RANGE: 422,
  /** §7.7 — the attestation checkbox ("I confirm this dose was administered…") was not checked. The
   *  attestation IS the legal basis for the record; without it there is nothing to write. */
  ATTESTATION_ABSENT: 422,
  /** §7.7 — the caller is neither the primary caregiver nor the DPOA (the `portal_caregiver_is_primary_or_dpoa`
   *  predicate is false). Only those relationships may attest a dose into the chart. */
  ATTESTATION_RELATIONSHIP_FORBIDDEN: 403,

  // ── §7.8 document upload → M22 intake ────────────────────────────────────────────────────────────────
  /** §7.8 VERBATIM — `413 Payload Too Large`. The upload exceeds the platform floor (50 MB) or the
   *  tenant-tightened cap; M31 emits no `uploaded` event (only `upload_rejected`). */
  UPLOAD_TOO_LARGE: 413,
  /** §7.8 VERBATIM — `415 Unsupported Media Type`. The declared MIME is not in the allowlist
   *  {PDF, JPEG, PNG, HEIC, TIFF}. */
  UPLOAD_MIME_NOT_ALLOWED: 415,
  /** §7.8 — the server-side magic-byte re-check does not match the declared MIME (a `.pdf` whose bytes are
   *  an executable). Fails CLOSED: a content-type spoof never reaches M22 intake. */
  UPLOAD_MAGIC_BYTE_MISMATCH: 415,
  /** GAP-092 — the bytes that arrived are not the size declared at upload-init (a truncated or swapped body). */
  UPLOAD_SIZE_MISMATCH: 422,

  // ── §7.9 amendment request (HIPAA §164.526) ──────────────────────────────────────────────────────────
  /** §7.9 — the amendment names no target (the M5 field / M8 encounter narrative to correct) or carries no
   *  requested change. M5 owns the canonical request + the 60-day SLA; M31 refuses to submit an empty one. */
  AMENDMENT_TARGET_INVALID: 422,

  // ── §7.6 post-discharge non-death grace (read-only) ──────────────────────────────────────────────────
  /** §7.6 — during the 30-day post-discharge (non-death) grace, grants are READ-ONLY: every write path
   *  (attestation, upload, amendment, message) is denied with the §7.6 explanation. A discharged patient's
   *  record may be reviewed but not written from the portal. */
  PATIENT_DISCHARGED_READ_ONLY: 403,
} as const;

/** A machine-readable M31 write-path failure code (§7.7–§7.9). */
export type M31WriteErrorCode = keyof typeof M31_WRITE_ERROR_STATUS;

/**
 * A guard / validation failure on one of the M31 portal write paths (§7.7–§7.9). Carries the precise code so
 * the §5 screens render an exact message; the M1 error handler maps `statusCode` to the HTTP response. Extends
 * the M1 `WardenXError` envelope base (packages/types — NOT the banned packages/foundation), parallel to the
 * T03 `PortalStateError` and the T05 `TelehealthStateError`.
 */
export class PortalWriteError extends WardenXError {
  constructor(code: M31WriteErrorCode, message: string) {
    super(code, message, M31_WRITE_ERROR_STATUS[code]);
    this.name = "PortalWriteError";
  }
}

/**
 * Throw a {@link PortalWriteError} when `condition` is false (guard helper). Declared `asserts condition` for
 * the same reason as `requirePortal` (T03): a guard that proves a fact must let the compiler keep it, so no
 * caller needs a `!` that survives a later refactor.
 */
export function requirePortalWrite(
  condition: boolean,
  code: M31WriteErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new PortalWriteError(code, message);
}

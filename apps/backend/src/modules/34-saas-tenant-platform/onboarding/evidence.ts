// apps/backend/src/modules/34-saas-tenant-platform/onboarding/evidence.ts — attestation input rules (pure).
//
// A human who marks a step done must say why: `evidenceNote` is required (trimmed, non-empty, at most 2000 characters)
// and `evidenceRef` is an optional pointer (a ticket, a document id) of at most 500. The route schema bounds the raw
// strings; this is the authority on the trimmed values the database CHECKs repeat.
import { ChartWardenError } from "@chartwarden/types";

export const EVIDENCE_NOTE_MAX = 2000;
export const EVIDENCE_REF_MAX = 500;
export const REASON_MIN = 8;
export const REASON_MAX = 1000;

export interface NormalizedEvidence {
  readonly note: string;
  readonly ref: string | null;
}

const refuse = (code: string, field: string, message: string): ChartWardenError =>
  new ChartWardenError(code, message, 422, [{ field, code, message }]);

export function normalizeEvidence(input: {
  readonly evidenceNote?: unknown;
  readonly evidenceRef?: unknown;
}): NormalizedEvidence {
  const note = typeof input.evidenceNote === "string" ? input.evidenceNote.trim() : "";
  if (note.length === 0) {
    throw refuse(
      "ONBOARDING_EVIDENCE_REQUIRED",
      "evidenceNote",
      "evidenceNote is required to mark a step done: say what was checked and by whom",
    );
  }
  if (note.length > EVIDENCE_NOTE_MAX) {
    throw refuse(
      "ONBOARDING_EVIDENCE_INVALID",
      "evidenceNote",
      `evidenceNote must be at most ${EVIDENCE_NOTE_MAX} characters`,
    );
  }
  const rawRef = typeof input.evidenceRef === "string" ? input.evidenceRef.trim() : "";
  if (rawRef.length > EVIDENCE_REF_MAX) {
    throw refuse(
      "ONBOARDING_EVIDENCE_INVALID",
      "evidenceRef",
      `evidenceRef must be at most ${EVIDENCE_REF_MAX} characters`,
    );
  }
  return { note, ref: rawRef.length === 0 ? null : rawRef };
}

/** The written reason a platform operator gives for an override (attest, re-open, approve, revoke). */
export function normalizeReason(reason: unknown): string {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length < REASON_MIN || text.length > REASON_MAX) {
    throw refuse(
      "ONBOARDING_REASON_REQUIRED",
      "reason",
      `a reason of ${REASON_MIN} to ${REASON_MAX} characters is required`,
    );
  }
  return text;
}

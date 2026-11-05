// apps/backend/src/modules/34-saas-tenant-platform/onboarding/evidence.ts — attestation input rules (pure).
//
// A human who marks a step done must say why: `evidenceNote` is required (trimmed, non-empty, at most 2000 characters)
// and `evidenceRef` is an optional pointer (a ticket, a document id) of at most 500. The route schema bounds the raw
// strings; this is the authority on the trimmed values the database CHECKs repeat.
//
// Every free-text field the wizard stores goes through `cleanText`: NUL is refused as a typed 422 (Postgres text and
// jsonb cannot hold it, so it would otherwise surface as a 500), every other control character except tab and newline
// is stripped, and text that looks like a patient identifier (an SSN or MBI) is refused with a friendly 422 that never
// echoes the value.
import { ChartWardenError } from "@chartwarden/types";
import { looksLikePatientIdentifier } from "./phi-screen";

export const EVIDENCE_NOTE_MAX = 2000;
export const EVIDENCE_REF_MAX = 500;
export const REASON_MIN = 8;
export const REASON_MAX = 1000;
/** The platform skip rationale (the route schema allows the same). */
export const SKIP_RATIONALE_MAX = 2000;
export const BLOCKER_REASON_MIN = 5;
export const BLOCKER_REASON_MAX = 1000;

export interface NormalizedEvidence {
  readonly note: string;
  readonly ref: string | null;
}

const refuse = (code: string, field: string, message: string): ChartWardenError =>
  new ChartWardenError(code, message, 422, [{ field, code, message }]);

/** Every control character (\p{Cc}) except tab and newline. */
const STRIPPED_CONTROL = /[^\P{Cc}\t\n]/gu;

/**
 * The shared text hygiene: refuse NUL, strip the other control characters, trim, and refuse a patient identifier.
 * Length rules stay with each caller (they differ per field) and are judged on the cleaned text.
 */
function cleanText(field: string, raw: string): string {
  if (raw.includes("\u0000")) {
    throw refuse("ONBOARDING_TEXT_INVALID", field, `${field} must not contain NUL characters`);
  }
  const text = raw.replace(STRIPPED_CONTROL, "").trim();
  if (looksLikePatientIdentifier(text)) {
    throw refuse(
      "EVIDENCE_LOOKS_LIKE_PHI",
      field,
      `${field} looks like it contains a patient identifier (a Social Security or Medicare number). Describe what was checked without naming a patient, and cite documents by their title.`,
    );
  }
  return text;
}

export function normalizeEvidence(input: {
  readonly evidenceNote?: unknown;
  readonly evidenceRef?: unknown;
}): NormalizedEvidence {
  const note =
    typeof input.evidenceNote === "string" ? cleanText("evidenceNote", input.evidenceNote) : "";
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
  const rawRef =
    typeof input.evidenceRef === "string" ? cleanText("evidenceRef", input.evidenceRef) : "";
  if (rawRef.length > EVIDENCE_REF_MAX) {
    throw refuse(
      "ONBOARDING_EVIDENCE_INVALID",
      "evidenceRef",
      `evidenceRef must be at most ${EVIDENCE_REF_MAX} characters`,
    );
  }
  return { note, ref: rawRef.length === 0 ? null : rawRef };
}

/**
 * The written reason an operator or officer gives for a decision (attest, re-open, approve, revoke, skip, assign).
 * `max` and `field` let a caller keep its own bound and name (the officer assignment allows 500, a skip 2000).
 */
export function normalizeReason(
  reason: unknown,
  opts: { readonly max?: number; readonly field?: string } = {},
): string {
  const max = opts.max ?? REASON_MAX;
  const field = opts.field ?? "reason";
  const text = typeof reason === "string" ? cleanText(field, reason) : "";
  if (text.length < REASON_MIN || text.length > max) {
    throw refuse(
      "ONBOARDING_REASON_REQUIRED",
      field,
      `a reason of ${REASON_MIN} to ${max} characters is required`,
    );
  }
  return text;
}

/** An optional free-text note (the go-live attestation note): null when absent or blank. */
export function normalizeOptionalNote(note: unknown, max = EVIDENCE_NOTE_MAX): string | null {
  const text = typeof note === "string" ? cleanText("note", note) : "";
  if (text.length === 0) return null;
  if (text.length > max) {
    throw refuse("ONBOARDING_EVIDENCE_INVALID", "note", `note must be at most ${max} characters`);
  }
  return text;
}

/** Why a step is blocked: required, so the blocker is never silent. */
export function normalizeBlockerReason(reason: unknown): string {
  const text = typeof reason === "string" ? cleanText("blockerReason", reason) : "";
  if (text.length < BLOCKER_REASON_MIN || text.length > BLOCKER_REASON_MAX) {
    throw refuse(
      "ONBOARDING_REASON_REQUIRED",
      "blockerReason",
      `a blocker reason of ${BLOCKER_REASON_MIN} to ${BLOCKER_REASON_MAX} characters is required`,
    );
  }
  return text;
}

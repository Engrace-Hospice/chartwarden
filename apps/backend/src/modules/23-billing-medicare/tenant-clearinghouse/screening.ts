// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/screening.ts — the free text a clearinghouse record may carry
// (an attestation's evidence note, a BAA's document reference). It is typed by a person, so it is folded to one line, stripped of
// control characters, length-bounded and refused when it looks like a patient identifier (an SSN or an MBI shape): this is
// configuration, never a place for patient data.
import { looksLikeMbi } from "@chartwarden/billing";
import { ValidationError } from "@chartwarden/types";

const SSN_SHAPE = /(?<!\d)\d{3}[\s.-]?\d{2}[\s.-]?\d{4}(?!\d)/u;

export interface ScreenSpec {
  readonly field: string;
  readonly min: number;
  readonly max: number;
  readonly lengthCode: string;
  readonly lengthMessage: string;
  readonly phiMessage: string;
}

export const invalid = (field: string, code: string, message: string): ValidationError =>
  new ValidationError("request validation failed", [{ field, code, message }]);

/** The text normalised and checked, or a 422 naming the field. */
export function screenedText(raw: unknown, spec: ScreenSpec): string {
  const text =
    typeof raw === "string"
      ? raw
          .replace(/\s+/gu, " ")
          .replace(/\p{C}+/gu, "")
          .trim()
      : "";
  if (text.length < spec.min || text.length > spec.max) {
    throw invalid(spec.field, spec.lengthCode, spec.lengthMessage);
  }
  if (SSN_SHAPE.test(text) || looksLikeMbi(text)) {
    throw invalid(spec.field, "EVIDENCE_LOOKS_LIKE_PHI", spec.phiMessage);
  }
  return text;
}

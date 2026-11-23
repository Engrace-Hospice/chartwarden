import type { Candidate } from "../doclens-api";

export function canonicalFieldPath(fieldPath: string): string {
  return fieldPath.replace(/\[\d+\]/g, "[]");
}

function normalizedText(value: string | null): string {
  return (value ?? "").normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function normalizedPhone(value: string | null): string {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

export function normalizedCandidateValue(
  candidate: Pick<Candidate, "fieldPath" | "value">,
): string {
  return /patient\.phone(?:Home|Mobile)$/.test(candidate.fieldPath)
    ? normalizedPhone(candidate.value)
    : normalizedText(candidate.value);
}

export function isIndexedClinicalField(fieldPath: string): boolean {
  return /^(medications|allergies|diagnoses|problems|conditions)\[\d+\]\./.test(fieldPath);
}

/**
 * A key may be shared only when doing so cannot erase a clinically meaningful distinction.
 * Demographic scalars intentionally share a key so competing values become one reconciliation task.
 * Indexed clinical observations require the complete normalized value to match.
 */
export function candidateGroupingKey(candidate: Candidate): string {
  const canonical = canonicalFieldPath(candidate.fieldPath);
  if (candidate.fieldPath.startsWith("patient.")) return `scalar:${canonical}`;
  if (isIndexedClinicalField(candidate.fieldPath)) {
    return `clinical:${canonical}:${normalizedCandidateValue(candidate)}`;
  }
  // Unsupported list indices are semantic identity until the authoritative registry maps them.
  if (/\[\d+\]/.test(candidate.fieldPath)) {
    return `unmapped:${candidate.fieldPath}:${normalizedCandidateValue(candidate)}`;
  }
  return `scalar:${canonical}`;
}

export function hasConflictingValues(candidates: readonly Candidate[]): boolean {
  if (
    candidates.length < 2 ||
    !candidates.every((candidate) => candidate.fieldPath.startsWith("patient."))
  ) {
    return false;
  }
  return new Set(candidates.map(normalizedCandidateValue)).size > 1;
}

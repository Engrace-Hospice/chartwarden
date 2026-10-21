// @chartwarden/types - shared building blocks of the typed M22 render payloads (GAP-033). A source module builds one
// of these AT THE PRODUCER, inside the signing transaction, from the rows it owns, and ships it on the
// outbox event as `renderPayload`; M22 validates it at the render boundary and draws ONLY the declared fields
// (an allow-list, so a plumbing key can never reach a legal document). Pure: no db / app import (leaf contract
// surface). Lives here, not in @chartwarden/forms, because M6 produces and M22 consumes and neither may import
// the other (ADR-0005).
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const nonEmpty = Type.String({ minLength: 1 });
const nullableText = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);

export const RENDER_SIGNATURE_METHODS = ["electronic", "wet_ink_scanned", "verbal_cosign"] as const;
export type RenderSignatureMethod = (typeof RENDER_SIGNATURE_METHODS)[number];

export const RENDER_SIGNATURE_MEANINGS = [
  "certification",
  "attestation",
  "acknowledgment",
  "authorship",
  "witness",
  "revocation",
  "discharge_order",
  "cosignature",
  "order_authorization",
] as const;
export type RenderSignatureMeaning = (typeof RENDER_SIGNATURE_MEANINGS)[number];

/**
 * A 21 CFR 11.50 signature manifestation: who signed (printed name, credentials, NPI when the master record
 * carries one), when, how, and what the signature means. Derived from the artifact's own rows - NEVER from the
 * request body. `signedAt` is an ISO instant, or a calendar date (`YYYY-MM-DD`) where the source only records
 * a date (a notice-of-rights acknowledgment, a revocation).
 */
export const SignatureRecord = Type.Object({
  role: nonEmpty,
  printedName: nonEmpty,
  credentials: nullableText,
  npi: nullableText,
  /** The signer's capacity when it is not the person themself ("Authorized representative"). */
  capacity: nullableText,
  signedAt: nonEmpty,
  method: Type.Union(RENDER_SIGNATURE_METHODS.map((m) => Type.Literal(m))),
  meaning: Type.Union(RENDER_SIGNATURE_MEANINGS.map((m) => Type.Literal(m))),
  /** The id of the signed artifact; printed shortened as the signature record reference. */
  recordId: nonEmpty,
});
export type SignatureRecord = Static<typeof SignatureRecord>;

/**
 * A signature manifestation for a signer whose signing time the source row does not record (a notice-of-rights
 * witness: the acknowledgment row carries one date, the witness's own time is not captured). `signedAt` is
 * omitted rather than invented - the form prints the name and meaning, no time.
 */
export const UndatedSignatureRecord = Type.Composite([
  Type.Omit(SignatureRecord, ["signedAt"]),
  Type.Object({ signedAt: Type.Optional(nonEmpty) }),
]);
export type UndatedSignatureRecord = Static<typeof UndatedSignatureRecord>;

/** The patient identity every clinical/legal document carries on every page. */
export const RenderPatientIdentity = Type.Object({
  patientId: nonEmpty,
  name: nonEmpty,
  mrn: nonEmpty,
  dateOfBirth: nullableText,
});
export type RenderPatientIdentity = Static<typeof RenderPatientIdentity>;

export const RenderDiagnosis = Type.Object({ code: nonEmpty });
export type RenderDiagnosis = Static<typeof RenderDiagnosis>;

/** The first schema violations of `payload` against `schema`, as `path: message` strings (empty = valid). */
export function schemaViolations(schema: TSchema, payload: unknown): string[] {
  return [...Value.Errors(schema, payload)]
    .slice(0, 5)
    .map((e) => `${e.path || "/"}: ${e.message}`);
}

/** Raised when a typed render payload fails its schema. M22 retries then dead-letters (never a blank form). */
export class RenderPayloadError extends Error {
  readonly code = "MALFORMED_RENDER_PAYLOAD";
  constructor(
    readonly templateKey: string,
    readonly violations: readonly string[],
  ) {
    super(`invalid ${templateKey} render payload: ${violations.join("; ")}`);
    this.name = "RenderPayloadError";
  }
}

/** Validate at a boundary: the typed payload, or a thrown {@link RenderPayloadError} naming what is wrong. */
export function assertRenderPayload<T extends TSchema>(
  templateKey: string,
  schema: T,
  payload: unknown,
  extraViolations: (p: Static<T>) => string[] = () => [],
): Static<T> {
  const violations = schemaViolations(schema, payload);
  if (violations.length === 0) {
    const extra = extraViolations(payload as Static<T>);
    if (extra.length > 0) throw new RenderPayloadError(templateKey, extra);
    return payload as Static<T>;
  }
  throw new RenderPayloadError(templateKey, violations);
}

/**
 * 42 CFR Part 2 producer-side filter. ICD-10-CM F10-F19 are the substance-related disorders; a code in that
 * range identifies a Part 2 diagnosis, so it is withheld from the rendered document (only the COUNT travels)
 * and the layout prints the Part 2 withheld marker. The chart row keeps the full code. Free-text narratives are
 * clinician-authored and cannot be classified mechanically; they are rendered as written (documented residual).
 */
const PART2_ICD10 = /^F1[0-9]/i;

export function isPart2Diagnosis(code: string): boolean {
  return PART2_ICD10.test(code.trim());
}

/** Split codes into the ones that may be printed and the number withheld under Part 2. Pure, order-preserving. */
export function partitionPart2Diagnoses(codes: readonly string[]): {
  readonly shown: readonly RenderDiagnosis[];
  readonly withheldCount: number;
} {
  const cleaned = codes.map((c) => c.trim()).filter((c) => c.length > 0);
  const shown = cleaned.filter((c) => !isPart2Diagnosis(c)).map((code) => ({ code }));
  return { shown, withheldCount: cleaned.length - shown.length };
}

/** `schemaVersion` marker every typed payload carries so a legacy id-only payload is distinguishable. */
export const RENDER_PAYLOAD_VERSION = 2 as const;

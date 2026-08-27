// apps/backend/src/modules/28-fhir/routes/code-system-uris.ts — FHIR canonical code-system URI → the M38
// `code_system_id` it names (R13, #117).
//
// A FHIR client identifies a code system by its canonical URL; M38 keys its catalog by a short id. The two
// vocabularies have to meet somewhere, and this is the only place they do. Every URI below is the
// HL7-registered canonical for that system (THO / the FHIR spec's `sid` namespace) — none is invented, and
// a system whose canonical this map does not carry is answered with `not-supported` rather than guessed at:
// a `$validate-code` that resolves the wrong system would answer a question the caller did not ask.
//
// `cpt` is deliberately absent, mirroring `CodeSystemId` itself — it stays unrepresentable until the AMA
// licence decision (M38 §1.2 D4), so a CPT `$validate-code` is not-supported rather than a lookup miss.

/** Canonical FHIR URI → M38 `code_system_id`. */
export const FHIR_CODE_SYSTEM_URIS: Readonly<Record<string, string>> = {
  "http://hl7.org/fhir/sid/icd-10-cm": "icd10cm",
  "http://www.cms.gov/Medicare/Coding/ICD10": "icd10pcs",
  "http://snomed.info/sct": "snomed",
  "http://loinc.org": "loinc",
  "http://www.nlm.nih.gov/research/umls/rxnorm": "rxnorm",
  "http://hl7.org/fhir/sid/ndc": "ndc",
  "http://terminology.hl7.org/CodeSystem/HCPCS-all-codes": "hcpcs",
  "http://hl7.org/fhir/sid/cvx": "cvx",
  "https://www.nubc.org/CodeSystem/RevenueCodes": "revenue",
  "https://x12.org/codes/claim-adjustment-reason-codes": "carc",
  "https://x12.org/codes/remittance-advice-remark-codes": "rarc",
};

/**
 * Resolve a canonical URI to an M38 code-system id, or `null` when this server does not serve it.
 *
 * A trailing `|version` (the FHIR canonical-with-version form) is stripped: M38 is version-aware through
 * its own as-of resolution, and a client pinning `http://loinc.org|2.76` is naming the same SYSTEM.
 */
export function codeSystemIdForUri(uri: string): string | null {
  const canonical = uri.trim().split("|")[0] ?? "";
  return FHIR_CODE_SYSTEM_URIS[canonical] ?? null;
}

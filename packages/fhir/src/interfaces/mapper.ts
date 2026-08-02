// @wardenx/fhir — the `FhirMapper` contract (§4.5 D6, M28-T04).
//
// A `FhirMapper` translates ONE already-loaded domain entity into ONE FHIR resource. Mappers are PURE:
// same domain input + same `MapperContext.asOfDate` ⇒ byte-identical FHIR output. No AI rewrites, no
// narrative generation beyond the deterministic `text.div` builder (D14) — the AI-prohibited-zone
// (T05/W-FHIR-11) depends on this purity so a §164.528 disclosure record can be reproduced verbatim.
//
// The mapper does NOT read the database. Every read goes through a published reader seam BEFORE the
// mapper runs (the DiagnosticReport projector in §4.11 is the multi-source variant); the mapper only
// shapes the already-loaded row. Each mapper is FHIR-version-specific — R5 / R6 mappers are Phase-3
// compile-shells (D1), so every Phase-1 mapper pins `version: '4.0.1'`.

/**
 * Translates a domain entity `TDomain` into a FHIR resource `TFhir`.
 *
 * `profile` is the US Core StructureDefinition URL the output conforms to; the mapper stamps it into
 * `meta.profile` so a consumer's conformance test sees the profile it asked for.
 */
export interface FhirMapper<TDomain, TFhir> {
  readonly version: "4.0.1" | "5.0.0" | "6.0.0";
  readonly profile: string;
  map(domain: TDomain, ctx: MapperContext): TFhir;
}

/**
 * The per-request context every mapper is handed. Everything the mapper needs to assemble stable
 * reference URIs and honor the egress redaction decision, WITHOUT reaching for IO or a clock.
 *
 *   - `tenantFhirHost` / `identifierUriBase` — per-tenant URI bases (D9); the mapper never hard-codes a
 *     host, so a tenant's `Patient/{id}` and `MRN` identifier resolve inside the tenant's own namespace.
 *   - `asOfDate` — the pinned projection instant; a re-read at the same `asOfDate` re-produces the same
 *     bytes (determinism, W-FHIR-13/14).
 *   - `recipientClientId` / `redactSudContent` — the consent decision (D3) is made by the egress gate
 *     (T05) and handed to the mapper as a resolved boolean; the mapper never consults M39 itself.
 */
export interface MapperContext {
  readonly organizationId: string;
  readonly tenantFhirHost: string;
  readonly identifierUriBase: string;
  readonly asOfDate: string;
  readonly recipientClientId: string;
  readonly redactSudContent: boolean;
  readonly includeProvenance: boolean;
}

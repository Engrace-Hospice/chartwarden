// @chartwarden/fhir — identifier system URI assembly (§4.5 D9, M28-T04).
//
// D9 splits identifier namespaces: PLATFORM-owned URIs cover canonical identifiers shared across tenants
// (NPI, NDC, RxNorm) and are FHIR-spec-standard; PER-TENANT URIs cover tenant-private identifiers (MRN,
// internal patient ids) and resolve inside the tenant's own `identifierUriBase` so no tenant can mint a
// URI that resolves into another tenant's namespace. The mapper never hard-codes a host.

import type { MapperContext } from "../interfaces/mapper";

/** The platform-standard US NPI system (canonical, cross-tenant). */
export const NPI_SYSTEM = "http://hl7.org/fhir/sid/us-npi";
/** The platform-standard RxNorm system (canonical, cross-tenant). */
export const RXNORM_SYSTEM = "http://www.nlm.nih.gov/research/umls/rxnorm";
/** The platform-standard LOINC system. */
export const LOINC_SYSTEM = "http://loinc.org";
/** The platform-standard ICD-10-CM system. */
export const ICD10CM_SYSTEM = "http://hl7.org/fhir/sid/icd-10-cm";
/** The platform-standard SNOMED CT system. */
export const SNOMED_SYSTEM = "http://snomed.info/sct";

/** The per-tenant MRN identifier system (D9). */
export function mrnSystemUri(ctx: Pick<MapperContext, "identifierUriBase">): string {
  return `${ctx.identifierUriBase}/sid/mrn`;
}

// @chartwarden/fhir — the US Core 6.0 mandatory search-parameter catalog (§4.5 D6, M28-T04).
//
// The conformance bar consumers test against. This is a TYPED, per-resource catalog — the single place
// M28 knows the FHIR search grammar. Adding a parameter is a CODE change here; it cannot be configured at
// runtime (D6). A request naming a parameter absent from the resource's set returns 400 with
// `OperationOutcome.issue.code='not-supported'` (the translator enforces this).

/** `_count` bounds (D13 default 50, max 500). */
export const FHIR_SEARCH_COUNT_DEFAULT = 50;
export const FHIR_SEARCH_COUNT_MIN = 1;
export const FHIR_SEARCH_COUNT_MAX = 500;

/**
 * Per-resource mandatory search parameters. Keyed by FHIR resource type; each value is the closed set of
 * parameter NAMES the Phase-1 gateway understands for that resource. Result parameters (`_count`,
 * `_include`, `_revinclude`, `_summary`, `_elements`, `_sort`) are handled by the translator itself and
 * are legal on every search, so they are NOT listed per-resource.
 */
export const US_CORE_SEARCH_PARAMETERS: { readonly [resourceType: string]: ReadonlyArray<string> } =
  {
    Patient: ["_id", "identifier", "name", "family", "given", "birthdate", "gender"],
    Encounter: ["_id", "patient", "class", "date", "status"],
    Condition: ["_id", "patient", "category", "clinical-status", "code"],
    Goal: ["_id", "patient", "lifecycle-status", "target-date"],
    CarePlan: ["_id", "patient", "category", "status", "date"],
    MedicationRequest: ["_id", "patient", "intent", "status", "authoredon"],
    MedicationStatement: ["_id", "patient", "status", "effective"],
    DiagnosticReport: ["_id", "patient", "category", "code", "date", "status"],
    Observation: ["_id", "patient", "category", "code", "date", "status"],
  };

/** Result parameters legal on any search (translated by the translator, not a reader-seam filter). */
export const FHIR_RESULT_PARAMETERS: ReadonlySet<string> = new Set([
  "_count",
  "_include",
  "_revinclude",
  "_summary",
  "_elements",
  "_sort",
]);

/** True when `resourceType` is a searchable Phase-1 resource. */
export function isSearchableResource(resourceType: string): boolean {
  return Object.prototype.hasOwnProperty.call(US_CORE_SEARCH_PARAMETERS, resourceType);
}

/** True when `name` is a mandatory search parameter for `resourceType` (or a legal result parameter). */
export function isSupportedSearchParameter(resourceType: string, name: string): boolean {
  if (FHIR_RESULT_PARAMETERS.has(name)) return true;
  const set = US_CORE_SEARCH_PARAMETERS[resourceType];
  return set ? set.includes(name) : false;
}

/** Clamp/normalize a raw `_count` into [MIN, MAX], defaulting on a non-finite/absent value. */
export function normalizeCount(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return FHIR_SEARCH_COUNT_DEFAULT;
  const n = Math.trunc(raw);
  if (n < FHIR_SEARCH_COUNT_MIN) return FHIR_SEARCH_COUNT_MIN;
  if (n > FHIR_SEARCH_COUNT_MAX) return FHIR_SEARCH_COUNT_MAX;
  return n;
}

/** Extract the bare id from a FHIR reference value — accepts `Patient/123` or a bare `123`. */
export function parseReferenceId(value: string): string {
  const slash = value.lastIndexOf("/");
  return slash >= 0 ? value.slice(slash + 1) : value;
}

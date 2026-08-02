// @wardenx/fhir — the `FhirSearchTranslator` contract (§4.5 D6, M28-T04).
//
// The translator is the SINGLE POINT in M28 that knows the FHIR search grammar. It translates FHIR
// search syntax into typed reader-seam calls — NO SQL is constructed inside M28; every read goes through
// a published reader seam (architecture §25.15 "boundary check 5" applied to the interop layer). Adding
// a search parameter is a CODE change in `packages/fhir/src/r4/search/*`; it can never be configured at
// runtime (D6).

/** One search parameter off the query string, e.g. `patient=Patient/123`, `birthdate:gt=1970-01-01`. */
export interface FhirSearchParameter {
  name: string;
  modifier?: string;
  value: string;
}

/** A parsed FHIR search request. `count` is `_count` (1..500, default 50); `cursor` is the opaque,
 *  HMAC-signed (D13) continuation token — the translator treats it as opaque here. */
export interface FhirSearchRequest {
  resourceType: string;
  parameters: ReadonlyArray<FhirSearchParameter>;
  includes: ReadonlyArray<string>;
  revincludes: ReadonlyArray<string>;
  count: number;
  cursor?: string;
  summary?: "true" | "data" | "text" | "count";
  elements?: ReadonlyArray<string>;
}

/** An `OperationOutcome.issue` shape — the translator emits FHIR-conformant issues on validation
 *  failure, so the route can wrap them into an `OperationOutcome` verbatim. */
export interface FhirSearchIssue {
  severity: "error" | "warning" | "fatal" | "information";
  code: string;
  diagnostics: string;
  expression?: string;
}

/** The result of `validate()`. `valid: false` ⇒ the route answers 400 with these issues. */
export interface FhirSearchValidation {
  valid: boolean;
  issues: ReadonlyArray<FhirSearchIssue>;
}

/** The per-request context `resolve()` is handed — everything a downstream mapper's `MapperContext`
 *  needs plus the client's scope set for the `fhir_export_scope_satisfied` consult. */
export interface SearchContext {
  readonly organizationId: string;
  readonly recipientClientId: string;
  readonly allowedScopes: ReadonlyArray<string>;
  readonly tenantFhirHost: string;
  readonly identifierUriBase: string;
  readonly redactSudContent: boolean;
}

/** The outcome of one search page — projected FHIR resources plus the D13 continuation cursor. */
export interface SearchExecutionResult {
  rows: ReadonlyArray<unknown>;
  nextCursor: string | null;
  totalEstimate?: number;
}

/** A validated + bound search ready to run against the reader seams. `execute()` is the ONLY place IO
 *  happens; it is closed over the injected reader deps (the translator factory holds them). */
export interface ResolvedSearch {
  execute(): Promise<SearchExecutionResult>;
}

/** The translator. `validate` is PURE; `resolve` binds the request to the reader seams. */
export interface FhirSearchTranslator {
  validate(req: FhirSearchRequest): FhirSearchValidation;
  resolve(req: FhirSearchRequest, ctx: SearchContext): ResolvedSearch;
}

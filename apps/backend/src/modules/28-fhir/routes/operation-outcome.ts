// apps/backend/src/modules/28-fhir/routes/operation-outcome.ts — the FHIR-spec error envelope (§4.1).
//
// Every error on the FHIR-spec surface (routes 1–22) is an `OperationOutcome` (FHIR-spec) — not the
// ChartWarden error envelope, which the admin surface (23–39) uses. `issue.details.coding` carries the
// internal ChartWarden error code for cross-referencing (§4.1). The content type is `application/fhir+json`.
import type { FastifyReply } from "fastify";

export const FHIR_JSON_CONTENT_TYPE = "application/fhir+json";

/** FHIR `issue-type` codes M28's Phase-1 surface emits. */
export type FhirIssueCode =
  | "not-found"
  | "not-supported"
  | "forbidden"
  | "security"
  | "invalid"
  | "processing"
  | "throttled"
  | "login"
  | "unknown";

export type FhirIssueSeverity = "fatal" | "error" | "warning" | "information";

export interface FhirOperationOutcome {
  readonly resourceType: "OperationOutcome";
  readonly issue: ReadonlyArray<{
    readonly severity: FhirIssueSeverity;
    readonly code: FhirIssueCode;
    readonly diagnostics: string;
    readonly details?: { readonly coding: ReadonlyArray<{ system: string; code: string }> };
  }>;
}

/** Build a single-issue `OperationOutcome`. `wardenxCode` cross-references the internal error catalog. */
export function operationOutcome(
  severity: FhirIssueSeverity,
  code: FhirIssueCode,
  diagnostics: string,
  wardenxCode?: string,
): FhirOperationOutcome {
  return {
    resourceType: "OperationOutcome",
    issue: [
      {
        severity,
        code,
        diagnostics,
        ...(wardenxCode
          ? {
              details: {
                coding: [{ system: "https://wardenx.com/fhir/error-code", code: wardenxCode }],
              },
            }
          : {}),
      },
    ],
  };
}

/** Send an `OperationOutcome` at the given HTTP status with the `application/fhir+json` content type. */
export function sendOutcome(
  reply: FastifyReply,
  httpStatus: number,
  severity: FhirIssueSeverity,
  code: FhirIssueCode,
  diagnostics: string,
  wardenxCode?: string,
): FhirOperationOutcome {
  reply.code(httpStatus).header("content-type", FHIR_JSON_CONTENT_TYPE);
  return operationOutcome(severity, code, diagnostics, wardenxCode);
}

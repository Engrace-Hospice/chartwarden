// @wardenx/fhir — the `FhirSearchTranslator` implementation (§4.5 D6, W-FHIR-14, M28-T04).
//
// Translates FHIR search syntax into typed reader-seam calls — NO SQL inside M28. `validate` is PURE
// (grammar + parameter-catalog check); `resolve` binds the request to the injected reader deps and
// returns a `ResolvedSearch` whose `execute()` is the only IO.
//
// Phase 1 wires the `DiagnosticReport?patient=:id` path end-to-end (W-FHIR-14): the translator resolves
// it to `OrderProvider.searchOrdersByPatient(orgId, patientId, { kind: 'lab', limit })` and projects each
// returned order through the DiagnosticReport projector. Other resource types are grammar-KNOWN (so their
// parameters validate) but their execution wiring lands with each resource's route task — resolving one
// returns a `ResolvedSearch` that rejects with a clear diagnostic rather than inventing a partial result.

import type {
  FhirSearchIssue,
  FhirSearchRequest,
  FhirSearchTranslator,
  FhirSearchValidation,
  ResolvedSearch,
  SearchContext,
} from "../../interfaces/search-translator";
import type { DiagnosticReportProjectorDeps } from "../mappers/diagnostic-report/projector";
import { projectDiagnosticReport } from "../mappers/diagnostic-report/projector";
import { decodeCursor, encodeCursor } from "./cursor";
import {
  isSearchableResource,
  isSupportedSearchParameter,
  normalizeCount,
  parseReferenceId,
} from "./parameters";

/** The reader deps the translator's wired search paths close over. */
export interface FhirSearchTranslatorDeps {
  readonly diagnosticReport: DiagnosticReportProjectorDeps;
}

function issue(
  severity: FhirSearchIssue["severity"],
  code: string,
  diagnostics: string,
  expression?: string,
): FhirSearchIssue {
  return expression ? { severity, code, diagnostics, expression } : { severity, code, diagnostics };
}

function findParam(req: FhirSearchRequest, name: string): string | undefined {
  return req.parameters.find((p) => p.name === name)?.value;
}

export function createFhirSearchTranslator(deps: FhirSearchTranslatorDeps): FhirSearchTranslator {
  function validate(req: FhirSearchRequest): FhirSearchValidation {
    const issues: FhirSearchIssue[] = [];

    if (!isSearchableResource(req.resourceType)) {
      issues.push(
        issue("error", "not-supported", `Resource type '${req.resourceType}' is not supported for search.`),
      );
      return { valid: false, issues };
    }

    for (const p of req.parameters) {
      if (!isSupportedSearchParameter(req.resourceType, p.name)) {
        issues.push(
          issue(
            "error",
            "not-supported",
            `Search parameter '${p.name}' is not supported for ${req.resourceType}.`,
            `${req.resourceType}.${p.name}`,
          ),
        );
      }
    }

    // Compartment-scoped resources require a patient anchor (no _id targeted read).
    const compartmentResources = new Set([
      "DiagnosticReport",
      "Observation",
      "Condition",
      "Goal",
      "CarePlan",
      "MedicationRequest",
      "MedicationStatement",
      "Encounter",
    ]);
    if (
      compartmentResources.has(req.resourceType) &&
      !findParam(req, "patient") &&
      !findParam(req, "_id")
    ) {
      issues.push(
        issue("error", "required", `The 'patient' search parameter is required for ${req.resourceType}.`),
      );
    }

    const valid = !issues.some((i) => i.severity === "error" || i.severity === "fatal");
    return { valid, issues };
  }

  function resolve(req: FhirSearchRequest, ctx: SearchContext): ResolvedSearch {
    if (req.resourceType === "DiagnosticReport") {
      return resolveDiagnosticReportSearch(req, ctx);
    }
    // Grammar-known resource whose execution wiring lands with its route task.
    return {
      async execute() {
        throw new Error(
          `FHIR search execution for '${req.resourceType}' is not yet wired in this phase.`,
        );
      },
    };
  }

  function resolveDiagnosticReportSearch(req: FhirSearchRequest, ctx: SearchContext): ResolvedSearch {
    const patientValue = findParam(req, "patient");
    const count = normalizeCount(req.count);
    const cursor = decodeCursor(req.cursor);

    return {
      async execute() {
        if (!patientValue) {
          throw new Error("DiagnosticReport search requires a 'patient' parameter.");
        }
        const patientId = parseReferenceId(patientValue);
        const orders = await deps.diagnosticReport.orderProvider.searchOrdersByPatient(
          ctx.organizationId,
          patientId,
          { kind: "lab", limit: count, afterId: cursor?.lastId },
        );

        const rows = [];
        for (const order of orders) {
          const report = await projectDiagnosticReport(deps.diagnosticReport, {
            organizationId: ctx.organizationId,
            orderId: order.id,
            clientId: ctx.recipientClientId,
          });
          if (report) rows.push(report);
        }

        const nextCursor =
          orders.length === count && orders.length > 0
            ? encodeCursor({ lastId: orders[orders.length - 1]!.id })
            : null;

        return { rows, nextCursor };
      },
    };
  }

  return { validate, resolve };
}

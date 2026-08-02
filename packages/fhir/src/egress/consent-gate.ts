// @wardenx/fhir — the 42 CFR Part 2 SUD egress consent gate (§8.2, D3, W-FHIR-03, M28-T05).
//
// D3 makes 42 CFR Part 2 SUD redaction DEFAULT-ON at every FHIR egress path. On EVERY resource
// projection step the gate consults M39's `ConsentEvaluator.evaluateForDisclosure` for the (patient,
// recipient) pair and acts on the decision (§8.2):
//   • `{ allowed: false }`                        → the resource is FILTERED from the response.
//   • `{ allowed: true, redactSudContent: true }` → SUD-class content is removed and the Bundle carries
//     an `OperationOutcome.issue.severity='warning'` per W-FHIR-03 (the §4001 information-blocking posture
//     is satisfied because the consumer is told *why* the data is absent, not handed a silent "no data").
//   • `{ allowed: true, redactSudContent: false }`→ the resource projects unchanged.
//
// The gate is a PURE enforcement layer with the M39 evaluator INJECTED as a LOCAL port (the T03/T04
// idiom — no `@wardenx/consent` import, no `dependsOn` edge ahead of the T06 seam bind). The redaction
// is a DETERMINISTIC filter/collapse, never an AI summarization (that is D14, `../ai-block`). A wholly-SUD
// resource (a buprenorphine `MedicationRequest`) has no non-SUD field to keep, so its strategy is
// `"filter"`; a `DiagnosticReport` collapses WHOLE-REPORT via the T04 D20 applier so a single hidden
// value is not inferable by exclusion — that applier is passed in as the redactor here.

import type { OperationOutcome } from "../r4/types";

/** The subset of M39's `evaluateForDisclosure` RESULT M28's egress gate reads (§8.2). Kept LOCAL to
 *  `packages/fhir`; the real result carries the HIV/MH/genetic/family-violence flags too, but the FHIR
 *  Phase-1 egress only governs the 42 CFR Part 2 SUD zone (the other sensitivity classes are M5
 *  PrivacyFlag-decided at the mapper level, a later task). */
export interface FhirDisclosureDecision {
  readonly allowed: boolean;
  readonly redactSudContent: boolean;
}

/** The M39 `ConsentEvaluator` disclosure port the gate consults per resource. The real evaluator from
 *  `@wardenx/consent` satisfies this (its `evaluateForDisclosure` returns a superset); T06 supplies the
 *  adapter that binds it. */
export interface FhirDisclosureConsentEvaluator {
  evaluateForDisclosure(args: {
    organizationId: string;
    patientId: string;
    recipientClientId?: string;
    asOf?: string;
  }): Promise<FhirDisclosureDecision>;
}

/** How the gate handles a resource whose SUD content the recipient may not see. `"filter"` drops the
 *  whole resource (a wholly-SUD resource — no non-SUD field survives); a redactor returns the SUD-collapsed
 *  resource in place (the `DiagnosticReport` D20 whole-report applier from T04). */
export type SudRedactionStrategy<R> = "filter" | ((resource: R) => R);

/** One resource offered to the gate: the projected resource, the patient it discloses, whether it carries
 *  42 CFR Part 2 SUD-class content, and how to redact that content if the recipient lacks a release. */
export interface EgressResourceInput<R> {
  readonly resource: R;
  readonly patientId: string;
  readonly sudClass: boolean;
  readonly onSudRedact: SudRedactionStrategy<R>;
}

/** The gate's per-resource verdict. `include` → project as-is; `redact` → project the collapsed resource
 *  plus a Bundle warning; `filter` → drop the resource, keep only the Bundle warning. */
export type EgressGateOutcome<R> =
  | { readonly action: "include"; readonly resource: R }
  | { readonly action: "redact"; readonly resource: R; readonly warning: OperationOutcome }
  | { readonly action: "filter"; readonly warning: OperationOutcome };

/** The W-FHIR-03 step-4 advisory text — verbatim, so the acceptance test can assert on it. */
export const PART2_CONSENT_ABSENT_TEXT = "filtered for 42 CFR Part 2; consent absent";
/** The advisory when a report is collapsed (not dropped) because it carried a SUD value. */
export const PART2_REDACTED_TEXT = "42 CFR Part 2 content redacted; consent absent";
/** The advisory when the whole disclosure is unauthorized (`allowed: false`). */
export const DISCLOSURE_UNAUTHORIZED_TEXT = "disclosure not authorized; no active consent on file";

/** The FHIR-conformant advisory for suppressed content — issue-type `suppressed` means "some information
 *  was not returned due to consent / privacy / access rules", which is exactly the W-FHIR-03 posture. */
function suppressedWarning(text: string): OperationOutcome {
  return {
    resourceType: "OperationOutcome",
    issue: [{ severity: "warning", code: "suppressed", details: { text } }],
  };
}

/**
 * The PURE per-resource decision: given a projected resource and M39's disclosure decision, return
 * whether to include, redact-then-include, or filter it. No IO — `gateResourceForEgress` wraps the M39
 * consult around this.
 */
export function applyEgressConsentGate<R>(
  input: EgressResourceInput<R>,
  decision: FhirDisclosureDecision,
): EgressGateOutcome<R> {
  if (!decision.allowed) {
    return { action: "filter", warning: suppressedWarning(DISCLOSURE_UNAUTHORIZED_TEXT) };
  }
  if (input.sudClass && decision.redactSudContent) {
    if (input.onSudRedact === "filter") {
      return { action: "filter", warning: suppressedWarning(PART2_CONSENT_ABSENT_TEXT) };
    }
    return {
      action: "redact",
      resource: input.onSudRedact(input.resource),
      warning: suppressedWarning(PART2_REDACTED_TEXT),
    };
  }
  return { action: "include", resource: input.resource };
}

/** Consult M39 for one resource and apply the gate (§8.2 "per-resource consult, not per-client"). */
export async function gateResourceForEgress<R>(
  evaluator: FhirDisclosureConsentEvaluator,
  ctx: { organizationId: string; recipientClientId?: string; asOf?: string },
  input: EgressResourceInput<R>,
): Promise<EgressGateOutcome<R>> {
  const decision = await evaluator.evaluateForDisclosure({
    organizationId: ctx.organizationId,
    patientId: input.patientId,
    recipientClientId: ctx.recipientClientId,
    asOf: ctx.asOf,
  });
  return applyEgressConsentGate(input, decision);
}

/** The surviving resources plus the de-duplicated advisories to fold into the response Bundle. */
export interface EgressBundleResult<R> {
  readonly resources: R[];
  readonly warnings: OperationOutcome[];
}

/**
 * Run a whole search / `$everything` result set through the gate (W-FHIR-14 + W-FHIR-03). The consult is
 * per-resource (not per-job) so a mixed-patient Bundle applies each patient's own consent; the advisories
 * are de-duplicated on their detail text so a 50-row page with 30 SUD filters carries ONE warning, not 30.
 */
export async function gateBundleForEgress<R>(
  evaluator: FhirDisclosureConsentEvaluator,
  ctx: { organizationId: string; recipientClientId?: string; asOf?: string },
  inputs: readonly EgressResourceInput<R>[],
): Promise<EgressBundleResult<R>> {
  const resources: R[] = [];
  const warnings: OperationOutcome[] = [];
  const seenText = new Set<string>();
  for (const input of inputs) {
    const outcome = await gateResourceForEgress(evaluator, ctx, input);
    if (outcome.action === "include") {
      resources.push(outcome.resource);
      continue;
    }
    if (outcome.action === "redact") resources.push(outcome.resource);
    const text = outcome.warning.issue[0]?.details?.text ?? "";
    if (!seenText.has(text)) {
      seenText.add(text);
      warnings.push(outcome.warning);
    }
  }
  return { resources, warnings };
}

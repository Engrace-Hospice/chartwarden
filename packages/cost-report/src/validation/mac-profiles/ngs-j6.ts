// @wardenx/cost-report — M27 NGS-J6 ADDITIVE MAC validation rule set (D16, §7.8). MACs carry
// jurisdiction-specific cost-report quirks (statistical-basis conventions, supporting-documentation
// requirements, rejection-code mappings); rather than fork the engine, each MAC ships an ADDITIVE rule
// file layered on the platform defaults. NGS-J6 (National Government Services, Jurisdiction 6 — Engrace's
// MAC) ships Phase 1; CGS / Palmetto / Noridian / WPS / FCSO / NHIC follow as sibling files in this
// directory with no engine change (D16). Every rule here carries `macJurisdictionScope: 'NGS-J6'` so the
// engine applies it ONLY to NGS-J6 reports.
//
// Determinism (D8) + no PHI (D18): same predicate discipline as the platform defaults — pure functions
// of aggregate `ValidationContext` figures; integer-cents / boolean checks only.
//
// TODO(CMS-fixture): the exact NGS-J6 quirks (which supporting schedules NGS requires, the NGS statistical-
// basis expectations, the NGS rejection-code catalog) require NGS-J6 reference material we do not yet
// hold. These rules implement deterministic structural checks now; each is flagged where NGS-published
// reference data is needed — no NGS-specific constant is fabricated as if verified.
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import type { RuleDef } from "../types";
import { passResult, warnResult, skipResult } from "../types";

/** The MAC jurisdiction code this profile scopes to (matches `cost_report_validation_rule.mac_jurisdiction_scope`). */
export const NGS_J6_MAC_SCOPE = "NGS-J6";

const ngsJ6OwnershipAttestation: RuleDef = {
  ruleCode: "mac.ngs_j6.s2_ownership_attestation",
  category: "mac_specific",
  description: "NGS-J6: Worksheet S-2 ownership/related-party attestation is present (NGS reviews this closely).",
  severity: "warn",
  regulatoryRequired: false,
  macJurisdictionScope: NGS_J6_MAC_SCOPE,
  // TODO(CMS-fixture): NGS-J6's specific S-2 attestation expectations need NGS reference material; this
  // checks only that a related-party/ownership disclosure exists.
  evaluate: (ctx) =>
    ctx.demographics.relatedPartyDisclosed
      ? passResult("NGS-J6 S-2 ownership attestation present.")
      : warnResult(
          "NGS-J6 expects a completed S-2 ownership/related-party attestation.",
          "Complete the S-2 ownership disclosure before submitting to NGS-J6.",
        ),
};

const ngsJ6SupportingSchedules: RuleDef = {
  ruleCode: "mac.ngs_j6.supporting_schedules_present",
  category: "supporting_docs",
  description: "NGS-J6: the supporting schedule attachments NGS requires for hospice cost reports are present.",
  severity: "warn",
  regulatoryRequired: false,
  macJurisdictionScope: NGS_J6_MAC_SCOPE,
  // TODO(CMS-fixture): the precise NGS-J6 supporting-schedule checklist needs NGS-published guidance;
  // this defers to the S-2 attachment presence flag pending that checklist.
  evaluate: (ctx) =>
    ctx.supportingDocs.s2AttachmentsPresent
      ? passResult("NGS-J6 supporting schedules present.")
      : warnResult(
          "NGS-J6 supporting schedules appear incomplete.",
          "Attach the NGS-required supporting schedules for the cost report.",
        ),
};

const ngsJ6StatisticalBasis: RuleDef = {
  ruleCode: "mac.ngs_j6.statistical_basis_present",
  category: "statistical_data",
  description: "NGS-J6: the statistical basis NGS expects for the cost-allocation step-down is present.",
  severity: "warn",
  regulatoryRequired: false,
  macJurisdictionScope: NGS_J6_MAC_SCOPE,
  // TODO(CMS-fixture): NGS-J6's specific statistical-basis convention needs NGS reference material; this
  // reuses the platform allocation-basis presence flag pending that convention.
  evaluate: (ctx) =>
    ctx.worksheets.statisticalBasisPresent
      ? passResult("NGS-J6 statistical basis present.")
      : warnResult(
          "NGS-J6 expects the cost-allocation statistical basis to be supplied.",
          "Provide the allocation statistics NGS-J6 requires for the step-down.",
        ),
};

const ngsJ6CapPositionReviewed: RuleDef = {
  ruleCode: "mac.ngs_j6.cap_position_reviewed",
  category: "cap",
  description: "NGS-J6: the aggregate-cap position is available for NGS settlement review.",
  severity: "info",
  regulatoryRequired: false,
  macJurisdictionScope: NGS_J6_MAC_SCOPE,
  evaluate: (ctx) => {
    if (!ctx.seams.capProviderBound || ctx.cap === null) {
      return skipResult("M26 cap provider not bound — NGS-J6 cap-position review deferred.", "seam_not_bound");
    }
    return passResult("NGS-J6 cap position is available for review.", {
      aggregateCapCents: ctx.cap.aggregateCapCents,
      aggregatePaymentsCents: ctx.cap.aggregatePaymentsCents,
    });
  },
};

/**
 * The NGS-J6 additive rule set (D16). The engine concatenates this onto `DEFAULT_VALIDATION_RULES` for an
 * NGS-J6 report and applies the MAC-scope filter; for any other MAC these rules are skipped by scope.
 */
export const NGS_J6_RULES: readonly RuleDef[] = [
  ngsJ6OwnershipAttestation,
  ngsJ6SupportingSchedules,
  ngsJ6StatisticalBasis,
  ngsJ6CapPositionReviewed,
] as const;

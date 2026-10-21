// @chartwarden/reporting — consumed-seam view of M39 (Consent). PRESENT producer (§4.4).
//
// M33 calls M39 `ConsentEvaluator.evaluateForReporting` at DRILLDOWN time only (never on aggregate
// tile reads): a drilldown that would expose patient identifiers is NARROWED (not refused) under SUD /
// family-violence redaction, the narrowing is audited (`report_drilldown_audit`, §4.10
// `m33.drilldown.emitted` with `isConsentNarrowed`). Bound to the live evaluator via `getSeam` (P2C).
export interface ReportingConsentConsumer {
  /**
   * M39 `ConsentEvaluator.evaluateForReporting` — decide whether a drilldown's patient identifiers must
   * be narrowed for the requesting actor. Returns the narrowed identifier set + the narrowing reason.
   */
  evaluateForReporting(input: {
    organizationId: string;
    actorMembershipId: string;
    patientIds: readonly string[];
  }): Promise<{
    allowedPatientIds: readonly string[];
    isNarrowed: boolean;
    reason: string | null;
  }>;
}

// @chartwarden/cost-report — the M27 tenant-offboarding / destruction eraseFn contract (M4 destruction
// registry, §3.7 / §8.4). Cost reports are COMPLIANCE-class survey evidence (7-year retention); the
// destruction path is GATED — a `cost_report` that has ever been `submitted`/`accepted` (or whose latest
// `ecr_submission.status='accepted'`) is destruction-BLOCKED on ordinary offboarding and may be reached
// only via M4's elevated-approval destruction-cert path (the agency's own filed copy is survey-evidence
// for the next five years, 42 CFR §413.20).
//
// PURE port-injected orchestration (the M30/M33/M34 `eraseTenant*` precedent): the sequence is a total
// function over an injected {@link CostReportEraseStore}; the composition root injects the Drizzle-backed
// store (each DELETE/redact under the offboarding tenancy context) in P3. No clock / RNG / Drizzle /
// `getSeam` import here.

/** The §3.7 ordered erase counts keyed by table (the M4 destruction-cert `tableCounts`). */
export type CostReportEraseTableCounts = Record<string, number>;

/** The destruction-cert fields the §3.7 elevated-approval gate reads (supplied once M4 cert-binding lands). */
export interface CostReportDecisionCert {
  /** Destruction scope; only an elevated cert may reach a submitted/accepted cost report. */
  readonly scope: string;
  /** Approver role keys on the certificate (the elevated gate requires a `compliance_officer`). */
  readonly approverIds: readonly string[];
  /** Whether the certificate carries the elevated-approval path for submitted survey evidence. */
  readonly elevated: boolean;
}

export interface CostReportEraseOptions {
  readonly decisionCert?: CostReportDecisionCert;
}

/** Raised when the §3.7 gate refuses an erase that would destroy submitted survey evidence without elevation. */
export class CostReportEraseRefused extends Error {
  constructor(public readonly code: string) {
    super(`cost-report erase refused: ${code}`);
    this.name = "CostReportEraseRefused";
  }
}

/** Whether a cost report's lifecycle state makes it submitted survey-evidence (destruction-gated). */
export function isSurveyEvidenceState(state: string): boolean {
  return (
    state === "submitted" || state === "accepted" || state === "rejected" || state === "reopened"
  );
}

/**
 * The §3.7 gate predicate: may this cost report be destroyed under the given cert? A submitted/accepted/
 * rejected/reopened report (or one with an accepted ECR submission) requires an ELEVATED cert carrying a
 * `compliance_officer` approver. Never fails open — a missing cert on survey evidence denies.
 */
export function mayDestroyCostReport(input: {
  state: string;
  hasAcceptedSubmission: boolean;
  options?: CostReportEraseOptions;
}): boolean {
  const isEvidence = isSurveyEvidenceState(input.state) || input.hasAcceptedSubmission;
  if (!isEvidence) return true;
  const cert = input.options?.decisionCert;
  return Boolean(cert?.elevated && cert.approverIds.includes("compliance_officer"));
}

/** The per-table delete/redact surface the §3.7 sequence runs through (each scoped to the org). P3 wires it. */
export interface CostReportEraseStore {
  /** Operational config — cost_center_mapping + cost_report_validation_rule (tenant rows only). */
  deleteOperationalConfig(organizationId: string): Promise<CostReportEraseTableCounts>;
  /** Compliance-class survey evidence — counted; deleted ONLY under an elevated cert. */
  countComplianceEvidence(organizationId: string): Promise<CostReportEraseTableCounts>;
  deleteComplianceEvidence(organizationId: string): Promise<CostReportEraseTableCounts>;
}

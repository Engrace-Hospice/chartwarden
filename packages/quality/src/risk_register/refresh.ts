// @chartwarden/quality — M30 §7.9 / D13 (WF-20/21): the unified risk-register row shaping + severity bands.
//
// The risk register is the cross-cutting risk landscape — the UNION of four open-risk sources:
//   (a) open `sra_finding` rows with residual 5×5 score ≥ medium,
//   (b) open `incident_report` rows with severity ≥ moderate,
//   (c) `qapi_project` rows in `corrective_action`,
//   (d) `cop_compliance_status` rows with status ∈ {at_risk, deficient}.
// In production this is the `risk_register_view` MATERIALIZED VIEW (migration-owned; refreshed
// CONCURRENTLY) — NOT a base table and NOT duplicated here. This file provides the PURE row-shaping +
// severity-banding helpers the backend refresh/read worker (a LATER phase) uses to project each source
// row into the unified `RiskRegisterRow`, so the in-process projection and the SQL view agree on
// titles, scores, and bands.
//
// PURE DOMAIN (P2a): no SQL, no `REFRESH MATERIALIZED VIEW CONCURRENTLY`, no DB. The score constants
// and inclusion predicates mirror the §3.3 `risk_register_view` definition verbatim so the two cannot
// drift. Row date columns are Drizzle `Date`s; the helpers emit ISO-8601 instants.
import type { schema } from "@chartwarden/db";
import type { CopStatus, IncidentSeverity } from "../contracts";

/** The four risk sources unioned into the register (the SQL view's `source_kind` values, D13). */
export type RiskRegisterSource =
  | "sra_finding"
  | "incident_report"
  | "qapi_project"
  | "cop_compliance_status";

/** The severity band a register row is shown under (derived from its numeric `severityScore`). */
export type RiskSeverityBand = "critical" | "high" | "medium" | "low";

/**
 * One unified risk-register row — the projection shape of `risk_register_view` plus the derived band and
 * back-link the UI consumes (WF-20). `openedAt` is the source row's creation; `lastActivityAt` is its
 * last update (the SQL view's `as_of`).
 */
export interface RiskRegisterRow {
  /** Which source table the risk came from. */
  readonly sourceKind: RiskRegisterSource;
  /** The source row id (`risk_register_view.source_id`; unique with `sourceKind`). */
  readonly sourceId: string;
  /** Owning org (canonical app.org_id scope). */
  readonly organizationId: string;
  /** A source-specific parent/category reference (cycle id, program id, incident kind, …) or null. */
  readonly parentRef: string | null;
  /** Human-readable row title (matches the SQL view's `title`). */
  readonly title: string;
  /** Short description / summary (matches the SQL view's `description`, ≤200 chars). */
  readonly description: string;
  /** Numeric severity score (the SQL view's `severity_score`; drives the band + the org-severity sort). */
  readonly severityScore: number;
  /** The band `severityScore` falls into. */
  readonly severityBand: RiskSeverityBand;
  /** Patient id for patient-bound incident rows (PHI), else null. */
  readonly patientId: string | null;
  /** ISO-8601 instant the underlying risk opened (source `created_at`). */
  readonly openedAt: string;
  /** ISO-8601 instant of last activity on the source row (source `updated_at`; the SQL `as_of`). */
  readonly lastActivityAt: string;
  /** Relative back-link to the source detail surface (WF-20). */
  readonly backLinkUrl: string;
}

// -----------------------------------------------------------------------------
// Score constants + inclusion predicates — mirror the §3.3 risk_register_view SQL verbatim.
// -----------------------------------------------------------------------------

/** Incident severity → register score (matches the SQL `CASE i.severity` ladder). */
export const INCIDENT_SEVERITY_RISK_SCORE: Readonly<Record<IncidentSeverity, number>> = {
  critical: 25,
  severe: 20,
  moderate: 12,
  minor: 6,
};

/** CoP status → register score (matches the SQL `CASE c.status` ladder; `compliant` is excluded). */
export const COP_STATUS_RISK_SCORE: Readonly<Record<CopStatus, number>> = {
  deficient: 20,
  at_risk: 12,
  compliant: 0,
};

/** Flat score for a QAPI project in `corrective_action` (the SQL literal `12`). */
export const QAPI_CORRECTIVE_ACTION_RISK_SCORE = 12;

/** The "medium" residual-risk threshold on the 5×5 matrix gating SRA-finding inclusion (SQL `>= 8`). */
export const SRA_RESIDUAL_RISK_THRESHOLD = 8;

/** Incident severities that land on the register (the SQL `IN (...)` set). */
const INCIDENT_OPEN_SEVERITIES: ReadonlySet<IncidentSeverity> = new Set<IncidentSeverity>([
  "moderate",
  "severe",
  "critical",
]);

/** True iff an SRA finding is an OPEN register risk: not yet closed-out AND residual ≥ medium (WF-20). */
export function sraFindingIsOpenRisk(finding: schema.SraFinding): boolean {
  return (
    finding.status !== "mitigated" &&
    finding.status !== "accepted_risk" &&
    finding.residual5x5Score >= SRA_RESIDUAL_RISK_THRESHOLD
  );
}

/** True iff an incident is an OPEN register risk: not closed-followup-complete AND severity ≥ moderate. */
export function incidentIsOpenRisk(incident: schema.IncidentReport): boolean {
  return (
    incident.lifecycle !== "closed_followup_complete" &&
    INCIDENT_OPEN_SEVERITIES.has(incident.severity)
  );
}

/** True iff a QAPI project is an OPEN register risk: it is in the `corrective_action` phase (D13). */
export function qapiProjectIsOpenRisk(project: schema.QapiProject): boolean {
  return project.status === "corrective_action";
}

/** True iff a CoP citation status is an OPEN register risk: `at_risk` or `deficient` (D13). */
export function copStatusIsOpenRisk(status: schema.CopComplianceStatus): boolean {
  return status.status === "at_risk" || status.status === "deficient";
}

// -----------------------------------------------------------------------------
// Severity banding + back-links.
// -----------------------------------------------------------------------------

/**
 * Band a numeric register score (WF-20). Thresholds align with the SQL scores: critical incidents (25)
 * / severe (20) / deficient CoP (20) → `critical`; the upper 5×5 residual band → `high`; moderate
 * incidents (12) / at-risk CoP / corrective-action QAPI (12) / medium residual → `medium`; the rest
 * → `low`.
 */
export function scoreToRiskSeverityBand(score: number): RiskSeverityBand {
  if (score >= 20) return "critical";
  if (score >= 13) return "high";
  if (score >= 8) return "medium";
  return "low";
}

/** Build the relative back-link to a source's detail surface (WF-20). */
export function buildRiskBackLink(source: RiskRegisterSource, sourceId: string): string {
  switch (source) {
    case "sra_finding":
      return `/quality/sra/findings/${sourceId}`;
    case "incident_report":
      return `/quality/incidents/${sourceId}`;
    case "qapi_project":
      return `/quality/qapi/projects/${sourceId}`;
    case "cop_compliance_status":
      return `/quality/cop/citations/${sourceId}`;
  }
}

// -----------------------------------------------------------------------------
// Per-source row shaping.
// -----------------------------------------------------------------------------

/** Render a Drizzle `Date` (or ISO string) as an ISO-8601 instant. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function makeRow(
  sourceKind: RiskRegisterSource,
  sourceId: string,
  fields: Omit<RiskRegisterRow, "sourceKind" | "sourceId" | "severityBand" | "backLinkUrl">,
): RiskRegisterRow {
  return {
    sourceKind,
    sourceId,
    severityBand: scoreToRiskSeverityBand(fields.severityScore),
    backLinkUrl: buildRiskBackLink(sourceKind, sourceId),
    ...fields,
  };
}

/** Project an open SRA finding into a register row (severity = residual 5×5 score). */
export function sraFindingToRiskRow(finding: schema.SraFinding): RiskRegisterRow {
  return makeRow("sra_finding", finding.id, {
    organizationId: finding.organizationId,
    parentRef: finding.sraCycleId,
    title: `SRA Finding #${finding.findingNumber}`,
    description: finding.threatDescription,
    severityScore: finding.residual5x5Score,
    patientId: null,
    openedAt: toIso(finding.createdAt),
    lastActivityAt: toIso(finding.updatedAt),
  });
}

/** Project an open incident into a register row (severity per the incident-severity ladder). */
export function incidentToRiskRow(incident: schema.IncidentReport): RiskRegisterRow {
  const summary = typeof incident.kindData.summary === "string" ? incident.kindData.summary : "";
  return makeRow("incident_report", incident.id, {
    organizationId: incident.organizationId,
    parentRef: incident.kind,
    title: `${incident.kind} incident`,
    description: summary.slice(0, 200),
    severityScore: INCIDENT_SEVERITY_RISK_SCORE[incident.severity],
    patientId: incident.patientId,
    openedAt: toIso(incident.createdAt),
    lastActivityAt: toIso(incident.updatedAt),
  });
}

/** Project a corrective-action QAPI project into a register row (flat medium score). */
export function qapiProjectToRiskRow(project: schema.QapiProject): RiskRegisterRow {
  return makeRow("qapi_project", project.id, {
    organizationId: project.organizationId,
    parentRef: project.qapiProgramId,
    title: project.title,
    description: project.goalText,
    severityScore: QAPI_CORRECTIVE_ACTION_RISK_SCORE,
    patientId: null,
    openedAt: toIso(project.createdAt),
    lastActivityAt: toIso(project.updatedAt),
  });
}

/** Project a non-compliant CoP citation status into a register row. */
export function copStatusToRiskRow(status: schema.CopComplianceStatus): RiskRegisterRow {
  return makeRow("cop_compliance_status", status.id, {
    organizationId: status.organizationId,
    parentRef: status.copCitation,
    title: `CoP ${status.copCitation} ${status.status}`,
    description: status.selfAssessmentNotes ?? "",
    severityScore: COP_STATUS_RISK_SCORE[status.status],
    patientId: null,
    openedAt: toIso(status.createdAt),
    lastActivityAt: toIso(status.updatedAt),
  });
}

/** The four source-row collections the register unions (D13). Each is filtered by its open-risk predicate. */
export interface RiskRegisterSources {
  readonly sraFindings: readonly schema.SraFinding[];
  readonly incidents: readonly schema.IncidentReport[];
  readonly qapiProjects: readonly schema.QapiProject[];
  readonly copStatuses: readonly schema.CopComplianceStatus[];
}

/**
 * Build the unified register from the four source collections (WF-20): filter each by its open-risk
 * predicate, project to `RiskRegisterRow`, and sort by `severityScore` descending (the SQL view's
 * `idx_risk_register_org_severity` read order). Pure — the worker passes the rows it queried per org.
 */
export function buildRiskRegister(sources: RiskRegisterSources): RiskRegisterRow[] {
  const rows: RiskRegisterRow[] = [];
  for (const f of sources.sraFindings) {
    if (sraFindingIsOpenRisk(f)) rows.push(sraFindingToRiskRow(f));
  }
  for (const i of sources.incidents) {
    if (incidentIsOpenRisk(i)) rows.push(incidentToRiskRow(i));
  }
  for (const p of sources.qapiProjects) {
    if (qapiProjectIsOpenRisk(p)) rows.push(qapiProjectToRiskRow(p));
  }
  for (const c of sources.copStatuses) {
    if (copStatusIsOpenRisk(c)) rows.push(copStatusToRiskRow(c));
  }
  rows.sort((a, b) => b.severityScore - a.severityScore);
  return rows;
}

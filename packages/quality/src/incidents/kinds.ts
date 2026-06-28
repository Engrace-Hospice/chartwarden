// @wardenx/quality — M30 §2.3 / D8 incident-kind catalog + per-kind required-field rules (P2a).
//
// The six-kind incident taxonomy (V-14) as a PURE domain catalog: per-kind metadata, the required
// `kind_data` members each kind must carry before submission, the allowed `exposure_event` subkinds, and
// the sentinel-eligibility flag that drives the WF-11 alert path. There is NO Fastify TypeBox here — the
// route-layer per-kind request schemas land in a later phase; this file is the framework-free domain
// source of truth those schemas (and the lifecycle machine's submission guard) project from.
//
// `kind_data` is the open `IncidentKindData` jsonb payload (free-text members narrativeText / witnessNames
// / patientQuote / staffQuote are §3.6 audit-denylisted). The validation predicates below check only that
// the per-kind STRUCTURAL required members are present and non-empty — clinical content is never inspected.
import type { schema } from "@wardenx/db";
import type { IncidentKind, IncidentSeverity } from "../contracts";

/**
 * Total order over the §2.3 severity band, so a `severity ≥ moderate` predicate (the §2.2 closure
 * corrective-action gate, the WF-11 sentinel rule) is a single rank comparison. Mirrors
 * `m30_incident_severity`. Exported because the lifecycle machine reuses it.
 */
export const INCIDENT_SEVERITY_RANK: Readonly<Record<IncidentSeverity, number>> = {
  minor: 0,
  moderate: 1,
  severe: 2,
  critical: 3,
};

/** True iff `severity` is at or above `moderate` (the §2.2 corrective-action / risk-register threshold). */
export function isSeverityAtLeastModerate(severity: IncidentSeverity): boolean {
  return INCIDENT_SEVERITY_RANK[severity] >= INCIDENT_SEVERITY_RANK.moderate;
}

/**
 * The `exposure_event` subkinds that force the mandatory-reporter gate (V-15). Kept here (the kind
 * catalog) so the lifecycle submission guard and `./mandatory_reporter` resolve the same set.
 */
export const MANDATORY_REPORT_EXPOSURE_SUBKINDS = [
  "needle_stick",
  "phi_breach",
  "reportable_disease",
  "caregiver_violence",
] as const;

/** An `exposure_event` subkind that forces the mandatory-reporter gate (V-15). */
export type MandatoryReportExposureSubkind = (typeof MANDATORY_REPORT_EXPOSURE_SUBKINDS)[number];

/** Per-kind domain definition (D8): required `kind_data` members + sentinel/mandatory posture. */
export interface IncidentKindDefinition {
  /** The §2.3 kind code (V-14). */
  readonly kind: IncidentKind;
  /** Human-readable label (UI / survey-evidence). */
  readonly label: string;
  /**
   * The `kind_data` members that MUST be present and non-empty before `submit` (the §2.2 submission
   * `requiredFieldsComplete` fact resolves from {@link validateIncidentKindData}).
   */
  readonly requiredKindDataFields: ReadonlyArray<string>;
  /** The enumerated `kind_data.subkind` values this kind admits (omitted ⇒ subkind not used). */
  readonly allowedSubkinds?: ReadonlyArray<string>;
  /** This kind may be escalated to a sentinel event (WF-11) at `severity=critical`. */
  readonly sentinelEligible: boolean;
  /** This kind ALWAYS forces the mandatory-reporter gate regardless of subkind (V-15: allegation_of_abuse). */
  readonly alwaysMandatoryReport: boolean;
  /** The default severity an auto-created draft of this kind opens at (operator may raise at triage). */
  readonly defaultSeverity: IncidentSeverity;
}

/**
 * The six-kind incident catalog (V-14 / D8). Frozen: the kind list mirrors `m30_incident_kind` verbatim;
 * a new kind is a schema + catalog change, never an ad-hoc string.
 */
export const INCIDENT_KIND_CATALOG: Readonly<Record<IncidentKind, IncidentKindDefinition>> = {
  fall: {
    kind: "fall",
    label: "Fall",
    requiredKindDataFields: ["narrativeText"],
    sentinelEligible: true,
    alwaysMandatoryReport: false,
    defaultSeverity: "moderate",
  },
  medication_error: {
    // WF-14: a medication-error incident carries the offending `medicationOrderId` (resolved against M12
    // at the route layer). The "sentinel" medication error is a critical-severity med error (WF-11).
    kind: "medication_error",
    label: "Medication error",
    requiredKindDataFields: ["medicationOrderId", "narrativeText"],
    sentinelEligible: true,
    alwaysMandatoryReport: false,
    defaultSeverity: "moderate",
  },
  complaint: {
    kind: "complaint",
    label: "Complaint / grievance",
    requiredKindDataFields: ["narrativeText"],
    sentinelEligible: false,
    alwaysMandatoryReport: false,
    defaultSeverity: "minor",
  },
  allegation_of_abuse: {
    // V-15: always mandatory-report (state DHS/APS). Always sentinel-eligible; any state change audits
    // at severity=critical (§2.2).
    kind: "allegation_of_abuse",
    label: "Allegation of abuse / neglect / exploitation",
    requiredKindDataFields: ["narrativeText"],
    sentinelEligible: true,
    alwaysMandatoryReport: true,
    defaultSeverity: "severe",
  },
  exposure_event: {
    // V-15: mandatory-report when subkind ∈ MANDATORY_REPORT_EXPOSURE_SUBKINDS.
    kind: "exposure_event",
    label: "Exposure event",
    requiredKindDataFields: ["subkind", "narrativeText"],
    allowedSubkinds: [...MANDATORY_REPORT_EXPOSURE_SUBKINDS],
    sentinelEligible: true,
    alwaysMandatoryReport: false,
    defaultSeverity: "moderate",
  },
  other_safety_event: {
    kind: "other_safety_event",
    label: "Other safety event",
    requiredKindDataFields: ["narrativeText"],
    sentinelEligible: false,
    alwaysMandatoryReport: false,
    defaultSeverity: "minor",
  },
};

/** The outcome of the per-kind structural-completeness check (the §2.2 `requiredFieldsComplete` fact). */
export interface IncidentKindDataValidation {
  /** True iff every {@link IncidentKindDefinition.requiredKindDataFields} member is present + non-empty. */
  readonly ok: boolean;
  /** The required members that are absent or empty (empty when `ok`). */
  readonly missing: ReadonlyArray<string>;
}

/** Read a `kind_data` member as a non-empty string/array signal (free-text is never inspected, only presence). */
function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Validate that `kindData` carries the structural members `kind` requires before submission (V-14 per-kind
 * completeness). PURE — presence-only; it does NOT inspect free-text content. The route layer's TypeBox
 * schema is the type-level guard; this is the lifecycle-machine-facing domain fact. An unknown subkind on
 * an `exposure_event` is reported via `missing: ['subkind']` semantics only when `subkind` is absent — a
 * present-but-disallowed subkind is a route-validation concern, surfaced by {@link isAllowedSubkind}.
 */
export function validateIncidentKindData(
  kind: IncidentKind,
  kindData: schema.IncidentKindData,
): IncidentKindDataValidation {
  const def = INCIDENT_KIND_CATALOG[kind];
  const missing = def.requiredKindDataFields.filter((field) => !isPresent(kindData[field]));
  return { ok: missing.length === 0, missing };
}

/** True iff `subkind` is an admitted member of `kind`'s subkind set (or the kind takes no subkind). */
export function isAllowedSubkind(kind: IncidentKind, subkind: string | undefined): boolean {
  const allowed = INCIDENT_KIND_CATALOG[kind].allowedSubkinds;
  if (allowed === undefined) return subkind === undefined;
  return subkind !== undefined && allowed.includes(subkind);
}

/**
 * True iff an incident of this `kind`/`severity` is a SENTINEL event (WF-11 — drives the immediate
 * `incident_sentinel` / `incident_abuse_allegation` alert on submit). `allegation_of_abuse` is always
 * sentinel; the other sentinel-eligible kinds qualify only at `severity=critical`.
 */
export function isSentinelIncident(kind: IncidentKind, severity: IncidentSeverity): boolean {
  if (kind === "allegation_of_abuse") return true;
  return (
    INCIDENT_KIND_CATALOG[kind].sentinelEligible &&
    INCIDENT_SEVERITY_RANK[severity] >= INCIDENT_SEVERITY_RANK.critical
  );
}

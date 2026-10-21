// @chartwarden/quality — M30 §2.3 / D8 / §10 mandatory external-report determination (P2a). PURE.
//
// The actual external-agency notification is OUT-OF-SYSTEM and human-driven (§10): the audit trail of
// "external report filed at <time> with <ref>" lands in `incident_report.external_report_ref`. What M30
// owns is the DETERMINATION — given an incident kind + subkind, is an external mandatory report required,
// to which authority, on what timeliness, under which citation. That decision drives (a) the V-15
// submission gate (`incident_report.mandatory_report_flag`) and (b) the `m30.incident.mandatory_report_required`
// outbox event the Compliance Officer's workflow consumes. This file is the framework-free decision; the
// route + worker layers project it.
import type { IncidentKind } from "../contracts";
import { MANDATORY_REPORT_EXPOSURE_SUBKINDS, type MandatoryReportExposureSubkind } from "./kinds";

/** The external authority a mandatory report is filed with (§10 regulatory mapping). */
export type ReportingAuthority =
  | "state_aps_dhs" // state Adult Protective Services / Dept. of Human Services (elder-abuse)
  | "osha" // OSHA Bloodborne Pathogens Standard
  | "hhs_ocr" // HHS Office for Civil Rights (HIPAA breach)
  | "local_health_department"; // reportable-disease surveillance

/** The CMS/regulatory timeliness band for the external filing (§10). */
export type ReportingTimeliness =
  | "immediate" // suspected abuse / needle-stick post-exposure protocol
  | "within_24h"
  | "within_2_business_days"
  | "per_agency_policy"; // e.g., the HIPAA breach 60-day envelope — agency compliance workflow owns the clock

/** The §10 mandatory-report determination for one incident. */
export interface MandatoryReportDetermination {
  /** True iff this incident requires an external mandatory report (V-15). */
  readonly required: boolean;
  /** The authority the report is filed with (present iff `required`). */
  readonly authority?: ReportingAuthority;
  /** The timeliness band the filing must meet (present iff `required`). */
  readonly timeliness?: ReportingTimeliness;
  /** The regulatory basis / citation (present iff `required`). */
  readonly basis?: string;
  /** The triggering exposure subkind, echoed for the consumer (present iff the trigger was subkind-driven). */
  readonly subkind?: MandatoryReportExposureSubkind;
}

const NOT_REQUIRED: MandatoryReportDetermination = { required: false };

/** Per-mandatory-subkind authority/timeliness/citation mapping (§10). */
const EXPOSURE_SUBKIND_RULES: Readonly<
  Record<MandatoryReportExposureSubkind, Omit<MandatoryReportDetermination, "required" | "subkind">>
> = {
  needle_stick: {
    authority: "osha",
    timeliness: "immediate",
    basis:
      "OSHA Bloodborne Pathogens Standard, 29 CFR §1910.1030 (post-exposure protocol + sharps-injury log)",
  },
  phi_breach: {
    authority: "hhs_ocr",
    timeliness: "per_agency_policy",
    basis: "HIPAA Breach Notification Rule, 45 CFR §§164.400–414",
  },
  reportable_disease: {
    authority: "local_health_department",
    timeliness: "within_24h",
    basis: "State reportable-disease surveillance requirement (jurisdiction-specific schedule)",
  },
  caregiver_violence: {
    authority: "state_aps_dhs",
    timeliness: "immediate",
    basis: "State DHS / Adult Protective Services mandatory-reporter law",
  },
};

/** Type guard: is `subkind` one of the V-15 mandatory exposure subkinds. */
function isMandatoryExposureSubkind(
  subkind: string | undefined,
): subkind is MandatoryReportExposureSubkind {
  return (
    subkind !== undefined &&
    (MANDATORY_REPORT_EXPOSURE_SUBKINDS as ReadonlyArray<string>).includes(subkind)
  );
}

/**
 * Determine whether an incident requires an external mandatory report (V-15 / §10). PURE.
 *
 *   - `allegation_of_abuse` → ALWAYS required (state DHS/APS, immediate), regardless of subkind.
 *   - `exposure_event` → required iff `subkind ∈ {needle_stick, phi_breach, reportable_disease,
 *     caregiver_violence}`, with the per-subkind authority/timeliness/citation from §10.
 *   - every other kind → not required.
 *
 * The determination is advisory at draft time and ENFORCED at submit: the lifecycle machine refuses
 * `submit` when `required` is true but `incident_report.mandatory_report_flag` is unset.
 */
export function determineMandatoryReport(input: {
  readonly kind: IncidentKind;
  readonly subkind?: string;
}): MandatoryReportDetermination {
  if (input.kind === "allegation_of_abuse") {
    return {
      required: true,
      authority: "state_aps_dhs",
      timeliness: "immediate",
      basis: "State DHS / Adult Protective Services elder-abuse mandatory-reporter law",
    };
  }
  if (input.kind === "exposure_event" && isMandatoryExposureSubkind(input.subkind)) {
    return { required: true, subkind: input.subkind, ...EXPOSURE_SUBKIND_RULES[input.subkind] };
  }
  return NOT_REQUIRED;
}

/** Convenience boolean over {@link determineMandatoryReport} (the V-15 submission-gate fact). */
export function isMandatoryReportRequired(kind: IncidentKind, subkind?: string): boolean {
  return determineMandatoryReport({ kind, subkind }).required;
}

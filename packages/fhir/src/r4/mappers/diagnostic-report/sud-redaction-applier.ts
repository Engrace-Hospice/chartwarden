// @chartwarden/fhir — the D20 whole-report SUD redaction applier (§4.11.3, M28-T04).
//
// 42 CFR Part 2 redaction at DiagnosticReport granularity is WHOLE-REPORT (D20): if ANY contained
// Observation is SUD-class, the entire `result[]` is replaced with a single placeholder Observation.
// Per-value redaction would leak the SUD result by exclusion (a CBC that renders 2 of 3 values tells the
// consumer a third, hidden, value exists) — this mirrors the M22 v0.3 D20 precedent.
//
// The applier is PURE and STRUCTURAL: it keys only on the internal `R-SUD` marker the child-observation
// projector stamps into each SUD-class Observation's `meta.security`. It does NOT consult M39 — the
// consent decision (D3) is the egress gate's job (T05); by the time a report carries an `R-SUD` child the
// upstream `lab_observation.sud_redaction_status` already said "redact".

import type { DiagnosticReport, Observation } from "../../types";

/** The internal marker the child-observation projector stamps into a SUD-class Observation's
 *  `meta.security`. It never reaches the wire — the applier removes the SUD children entirely and emits
 *  the FHIR-standard `R` (restricted) label instead. */
export const SUD_SECURITY_MARKER_CODE = "R-SUD";

/** The FHIR-standard confidentiality label surfaced on a redacted report so a conforming consumer knows
 *  a Part-2 filter ran (D20). */
export const FHIR_RESTRICTED_SECURITY: {
  readonly system: string;
  readonly code: string;
  readonly display: string;
} = {
  system: "http://terminology.hl7.org/CodeSystem/v3-Confidentiality",
  code: "R",
  display: "restricted",
};

/** The 42 CFR Part 2 banner placed on the placeholder Observation (§4.11.3 / §7.15). */
export const SUD_REDACTION_BANNER =
  "Results subject to 42 CFR Part 2 protections. To view values, request an unredact grant via the SUD Disclosure workflow at the source EHR.";

/** True when a report carries at least one SUD-class contained Observation. */
export function reportHasSudResult(report: DiagnosticReport): boolean {
  return (report.contained ?? []).some((obs) =>
    obs.meta?.security?.some((s) => s.code === SUD_SECURITY_MARKER_CODE),
  );
}

/**
 * D20 whole-report redaction. If the report has no SUD child it is returned UNCHANGED (byte-identical,
 * so the non-SUD determinism tests hold). Otherwise `result[]` + `contained[]` collapse to one
 * placeholder Observation, `conclusion` is cleared, and the report-level `meta.security` gains the `R`
 * label. No SUD value, unit, or LOINC survives anywhere in the output (the §7.15 grep test).
 */
export function applySudRedactionToDiagnosticReport(report: DiagnosticReport): DiagnosticReport {
  if (!reportHasSudResult(report)) return report;

  const placeholderId = `${report.id}--sud-placeholder`;
  const placeholder: Observation = {
    resourceType: "Observation",
    id: placeholderId,
    status: "final",
    code: { text: "SUD-protected results" },
    subject: report.subject,
    effectiveDateTime: report.effectivePeriod?.start,
    dataAbsentReason: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/data-absent-reason",
          code: "temp-unknown",
          display: "Temporarily Unknown",
        },
      ],
    },
    note: [{ text: SUD_REDACTION_BANNER }],
  };

  return {
    ...report,
    result: [{ reference: `Observation/${placeholderId}` }],
    contained: [placeholder],
    conclusion: undefined,
    meta: {
      ...report.meta,
      security: [...(report.meta?.security ?? []), FHIR_RESTRICTED_SECURITY],
    },
  };
}

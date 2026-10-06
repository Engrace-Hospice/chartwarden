// HCI — ten indicators + the composite.
import {
  computeHciIndicator01,
  computeHciIndicator02,
  computeHciIndicator03,
  computeHciIndicator04,
  computeHciIndicator05,
  computeHciIndicator06,
  computeHciIndicator07,
  computeHciIndicator08,
  computeHciIndicator09,
  computeHciIndicator10,
  computeHciScore,
} from "./hci/index";
import type { HciCompositeInput } from "./hci/index";
// SSVI — nine metrics + the total (FY2027; internal estimate).
import {
  computeSsviMetric01,
  computeSsviMetric02,
  computeSsviMetric03,
  computeSsviMetric04,
  computeSsviMetric05,
  computeSsviMetric06,
  computeSsviMetric07,
  computeSsviMetric08,
  computeSsviMetric09,
  computeSsviScore,
} from "./ssvi/index";
// HOPE-derived (FY2028).
import { computeTimelyFollowUpNonPain, computeTimelyFollowUpPain } from "./hope_derived/index";
// HVLDL.
import { computeHvldl } from "./hvldl/index";
// Operational (CoP / non-CMS).
import {
  computeBereavementCoverageRate,
  computeBereavementRiskScreeningCompletenessRate,
  computeCarePlan15DayAdherence,
  computeComfortKitDeploymentToAdminMinutes,
  computeCostReportFilingCompliance,
  computeEvvComplianceRate,
  computeF2fWindowOnTimeRate,
  computeF2fWindowOverrideRate,
  computeHopeSfvOnTimeRate,
  computeHopeSubmissionAcceptanceRate,
  computeIdgCadenceAdherence,
  computeLateEncounterEntryRate,
  computeMissedDoseRate,
  computeOpioidOnAdmissionRate,
  computePrnEffectivenessDocumentedRate,
  computeSupervisoryVisitOnTime,
  computeVerbalOrderSignatureOnTime,
  computeVisitOnTimeRate,
  computeVolunteerComplianceGateRate,
} from "./operational/index";
// @wardenx/quality — M30 measure REGISTRATIONS: the concrete catalog-code → pure-calculator binding the
// `m30.measure_recompute` worker resolves a calculator by measure code through (§3.1, §4.8, V-8).
//
// `registry.ts` defines the PURE binder (`registerMeasure`) + the descriptor-only `MEASURE_CATALOG`, but
// imports no calculator (so the binder stays cycle-free and dependency-light). This leaf closes the gap
// the worker phase left open: it imports every concrete calculator and binds it to its catalog descriptor,
// producing `M30_MEASURE_REGISTRATIONS` (the list) + `buildMeasureRegistry()` (the by-code lookup the
// `MeasureRecomputePorts.registrations` map is built from). Without this, the worker's registration map is
// empty and every recompute fails closed with `MeasureRegistrationMissing` — calculators that boot but never
// compute. PURE: no IO; importing the calculators (all pure leaves) keeps `no-circular` (the calculators
// import the kernel `./result`, never the registry/this barrel).
//
// The period rule for each registration is DERIVED from the matching `MEASURE_CATALOG` entry (periodKind /
// family / activatesFy / calculatorVersion) so the binding cannot drift from the catalog — one source of
// truth for "which measures exist + when they activate", one for "what computes them", reconciled here.
import { MEASURE_CATALOG, registerMeasure } from "./registry";
import type { MeasureCalculator, MeasurePeriodRuleBinding, MeasureRegistration } from "./registry";
import type { ComputeMeasureInput } from "./result";

/**
 * Resolve the period rule for a measure `code` from its {@link MEASURE_CATALOG} descriptor. Throws loudly on
 * a code with no catalog entry (a registry/registrations drift surfaced at module construction, not at a
 * silent runtime no-op). Pure.
 */
function ruleForCode(code: string): MeasurePeriodRuleBinding {
  const entry = MEASURE_CATALOG.find((e) => e.code === code);
  if (entry === undefined) {
    throw new Error(
      `registrations.ts: no MEASURE_CATALOG entry for measure code '${code}' — registry/registrations drift`,
    );
  }
  return {
    periodKind: entry.periodKind,
    family: entry.family,
    activatesFy: entry.activatesFy,
    calculatorVersion: entry.calculatorVersion,
  };
}

/**
 * The HCI composite is the one calculator whose input ({@link HciCompositeInput}: the ten indicator results +
 * the per-FY threshold table) does NOT extend {@link ComputeMeasureInput} — it composes already-computed
 * indicator results rather than reducing a seam-fetched population, so it carries no org/period base. The
 * registry stores every calculator type-erased to `(never) => result` regardless of input shape (the worker
 * re-narrows at the call site via the per-family input provider), so erasing the composite through this cast
 * is sound — it only widens the constraint the binder's `I extends ComputeMeasureInput` generic enforces.
 */
const compositeCalculator = computeHciScore as unknown as MeasureCalculator<ComputeMeasureInput>;

/** The SSVI total composes persisted metric results exactly like the HCI composite — same erasure, same reason. */
const ssviCompositeCalculator = computeSsviScore as unknown as MeasureCalculator<ComputeMeasureInput>;

/**
 * Every M30 measure that has a CONCRETE pure calculator, bound to its catalog descriptor (§3.1). The HCI ten
 * indicators + composite, the SSVI nine metrics + total, HVLDL, the two HOPE-derived TFP measures, and the
 * operational measures — every {@link MEASURE_CATALOG} entry (the `cahps` family is a CAHPS-composite VALUE ingested from the
 * vendor result-summary pipeline, not a computed measure, so it carries no catalog row + no calculator here).
 * This is the list the worker's `registrations` map is built from; an unwired measure recompute still fails
 * closed loudly.
 */
export const M30_MEASURE_REGISTRATIONS: readonly MeasureRegistration[] = [
  // HCI — ten indicators (FY2025).
  registerMeasure("hci_indicator_01", computeHciIndicator01, ruleForCode("hci_indicator_01")),
  registerMeasure("hci_indicator_02", computeHciIndicator02, ruleForCode("hci_indicator_02")),
  registerMeasure("hci_indicator_03", computeHciIndicator03, ruleForCode("hci_indicator_03")),
  registerMeasure("hci_indicator_04", computeHciIndicator04, ruleForCode("hci_indicator_04")),
  registerMeasure("hci_indicator_05", computeHciIndicator05, ruleForCode("hci_indicator_05")),
  registerMeasure("hci_indicator_06", computeHciIndicator06, ruleForCode("hci_indicator_06")),
  registerMeasure("hci_indicator_07", computeHciIndicator07, ruleForCode("hci_indicator_07")),
  registerMeasure("hci_indicator_08", computeHciIndicator08, ruleForCode("hci_indicator_08")),
  registerMeasure("hci_indicator_09", computeHciIndicator09, ruleForCode("hci_indicator_09")),
  registerMeasure("hci_indicator_10", computeHciIndicator10, ruleForCode("hci_indicator_10")),
  // HCI — composite (see {@link compositeCalculator} for the input-shape erasure note).
  registerMeasure("hci_composite", compositeCalculator, ruleForCode("hci_composite")),
  // SSVI — nine metrics + the total (FY2027).
  registerMeasure("ssvi_metric_01", computeSsviMetric01, ruleForCode("ssvi_metric_01")),
  registerMeasure("ssvi_metric_02", computeSsviMetric02, ruleForCode("ssvi_metric_02")),
  registerMeasure("ssvi_metric_03", computeSsviMetric03, ruleForCode("ssvi_metric_03")),
  registerMeasure("ssvi_metric_04", computeSsviMetric04, ruleForCode("ssvi_metric_04")),
  registerMeasure("ssvi_metric_05", computeSsviMetric05, ruleForCode("ssvi_metric_05")),
  registerMeasure("ssvi_metric_06", computeSsviMetric06, ruleForCode("ssvi_metric_06")),
  registerMeasure("ssvi_metric_07", computeSsviMetric07, ruleForCode("ssvi_metric_07")),
  registerMeasure("ssvi_metric_08", computeSsviMetric08, ruleForCode("ssvi_metric_08")),
  registerMeasure("ssvi_metric_09", computeSsviMetric09, ruleForCode("ssvi_metric_09")),
  registerMeasure("ssvi_composite", ssviCompositeCalculator, ruleForCode("ssvi_composite")),
  // HVLDL (FY2025).
  registerMeasure("hvldl", computeHvldl, ruleForCode("hvldl")),
  // HOPE-derived (FY2028).
  registerMeasure("tfp_pi", computeTimelyFollowUpPain, ruleForCode("tfp_pi")),
  registerMeasure("tfp_npsi", computeTimelyFollowUpNonPain, ruleForCode("tfp_npsi")),
  // Operational (FY2025).
  registerMeasure(
    "verbal_order_signature_on_time",
    computeVerbalOrderSignatureOnTime,
    ruleForCode("verbal_order_signature_on_time"),
  ),
  registerMeasure(
    "idg_cadence_adherence",
    computeIdgCadenceAdherence,
    ruleForCode("idg_cadence_adherence"),
  ),
  registerMeasure(
    "care_plan_15_day_adherence",
    computeCarePlan15DayAdherence,
    ruleForCode("care_plan_15_day_adherence"),
  ),
  registerMeasure(
    "supervisory_visit_on_time",
    computeSupervisoryVisitOnTime,
    ruleForCode("supervisory_visit_on_time"),
  ),
  registerMeasure(
    "bereavement_coverage_rate",
    computeBereavementCoverageRate,
    ruleForCode("bereavement_coverage_rate"),
  ),
  registerMeasure(
    "bereavement_risk_screening_completeness_rate",
    computeBereavementRiskScreeningCompletenessRate,
    ruleForCode("bereavement_risk_screening_completeness_rate"),
  ),
  registerMeasure(
    "volunteer_compliance_gate_rate",
    computeVolunteerComplianceGateRate,
    ruleForCode("volunteer_compliance_gate_rate"),
  ),
  registerMeasure(
    "evv_compliance_rate",
    computeEvvComplianceRate,
    ruleForCode("evv_compliance_rate"),
  ),
  registerMeasure("visit_on_time_rate", computeVisitOnTimeRate, ruleForCode("visit_on_time_rate")),
  registerMeasure("missed_dose_rate", computeMissedDoseRate, ruleForCode("missed_dose_rate")),
  registerMeasure(
    "prn_effectiveness_documented_rate",
    computePrnEffectivenessDocumentedRate,
    ruleForCode("prn_effectiveness_documented_rate"),
  ),
  registerMeasure(
    "comfort_kit_deployment_to_admin_minutes",
    computeComfortKitDeploymentToAdminMinutes,
    ruleForCode("comfort_kit_deployment_to_admin_minutes"),
  ),
  registerMeasure(
    "opioid_on_admission_rate",
    computeOpioidOnAdmissionRate,
    ruleForCode("opioid_on_admission_rate"),
  ),
  registerMeasure(
    "late_encounter_entry_rate",
    computeLateEncounterEntryRate,
    ruleForCode("late_encounter_entry_rate"),
  ),
  registerMeasure(
    "hope_submission_acceptance_rate",
    computeHopeSubmissionAcceptanceRate,
    ruleForCode("hope_submission_acceptance_rate"),
  ),
  registerMeasure(
    "hope_sfv_on_time_rate",
    computeHopeSfvOnTimeRate,
    ruleForCode("hope_sfv_on_time_rate"),
  ),
  registerMeasure(
    "cost_report_filing_compliance",
    computeCostReportFilingCompliance,
    ruleForCode("cost_report_filing_compliance"),
  ),
  registerMeasure(
    "f2f_window_on_time_rate",
    computeF2fWindowOnTimeRate,
    ruleForCode("f2f_window_on_time_rate"),
  ),
  registerMeasure(
    "f2f_window_override_rate",
    computeF2fWindowOverrideRate,
    ruleForCode("f2f_window_override_rate"),
  ),
];

/**
 * Build the by-measure-code registration lookup the `m30.measure_recompute` worker's
 * `MeasureRecomputePorts.registrations` map is. PURE — returns a fresh `Map` (no global mutable state); the
 * composition root injects this instead of the empty map so a recompute resolves its calculator by code. A
 * measure code with no registration here still fails closed loudly (`MeasureRegistrationMissing`).
 */
export function buildMeasureRegistry(): ReadonlyMap<string, MeasureRegistration> {
  return new Map(
    M30_MEASURE_REGISTRATIONS.map((registration) => [registration.code, registration]),
  );
}

// @wardenx/quality — M30 measure registry: the platform catalog of computed measures + a pure binder for
// wiring a measure code to its calculator + period rule (§3.1, D2/D14). Pure, IO-free.
//
// `MEASURE_CATALOG` is the descriptor-only source of truth — for each measure: its code, family, the
// period-kind it computes on, the fiscal year it ACTIVATES, and the semantic version of its calculator.
// `listMeasureCatalog(fiscalYear)` returns the subset active at/under a given FY (so the worker knows
// which calculators to run for a reporting cycle, and M34 knows which measures gate at FY rollover).
//
// `registerMeasure(code, calculator, periodRule)` is the PURE binder the worker phase uses to attach a
// concrete pure calculator to its descriptor at composition time; it keeps NO global state (no mutable
// singleton) and imports no calculator here — it type-erases the calculator to a homogeneous
// `AnyMeasureCalculator` so a heterogeneous set of per-measure input types can share one registration list.
import type { MeasurePeriodKind } from "../contracts";
import type { ComputeMeasureInput, QualityMeasureValueResult } from "./result";

/** The measure family a code belongs to (drives dashboard grouping + which seam reads it). */
export type MeasureFamily = "hci" | "hvldl" | "hope_derived" | "operational" | "cahps";

/** A pure measure calculator: a per-measure input type → the uniform result. */
export type MeasureCalculator<I extends ComputeMeasureInput = ComputeMeasureInput> = (
  input: I,
) => QualityMeasureValueResult;

/**
 * A type-erased calculator reference. Per-measure calculators have heterogeneous input types (each
 * extends {@link ComputeMeasureInput}); erasing the parameter to `never` lets every concrete
 * `MeasureCalculator<I>` be stored in one homogeneous registration list (the call site re-narrows).
 */
export type AnyMeasureCalculator = (input: never) => QualityMeasureValueResult;

/** A platform-catalog descriptor for one measure (no calculator reference — descriptor only). */
export interface MeasureCatalogEntry {
  /** The stable measure code (the `quality_measure_value.measure_code` value, V-1). */
  readonly code: string;
  /** The measure family. */
  readonly family: MeasureFamily;
  /** The period kind the measure computes on. */
  readonly periodKind: MeasurePeriodKind;
  /** The fiscal year the measure becomes ACTIVE (the worker runs it for FY ≥ this). */
  readonly activatesFy: number;
  /** The semantic version of the calculator that produces the value (stamped on the row). */
  readonly calculatorVersion: string;
  /** A short human description (dashboard label / catalog listing). */
  readonly description: string;
}

/** The period rule passed to {@link registerMeasure} — the period kind + activation FY + version. */
export interface MeasurePeriodRuleBinding {
  readonly periodKind: MeasurePeriodKind;
  readonly family: MeasureFamily;
  readonly activatesFy: number;
  readonly calculatorVersion: string;
}

/** A measure code bound to its (type-erased) calculator + period rule — the worker's wiring unit. */
export interface MeasureRegistration {
  readonly code: string;
  readonly calculator: AnyMeasureCalculator;
  readonly periodKind: MeasurePeriodKind;
  readonly family: MeasureFamily;
  readonly activatesFy: number;
  readonly calculatorVersion: string;
}

/**
 * Bind a measure `code` to its pure `calculator` and `periodRule`. PURE — returns a registration record;
 * holds no global state. The generic `I` preserves the calculator's input type at the call site while the
 * stored reference is type-erased to {@link AnyMeasureCalculator} (the `as` is sound because
 * `(input: I) => R` is assignable to `(input: never) => R`).
 */
export function registerMeasure<I extends ComputeMeasureInput>(
  code: string,
  calculator: MeasureCalculator<I>,
  periodRule: MeasurePeriodRuleBinding,
): MeasureRegistration {
  return {
    code,
    calculator: calculator as AnyMeasureCalculator,
    periodKind: periodRule.periodKind,
    family: periodRule.family,
    activatesFy: periodRule.activatesFy,
    calculatorVersion: periodRule.calculatorVersion,
  };
}

const ROLLING: MeasurePeriodKind = "rolling_12m_to_quarter";

/**
 * The platform measure catalog — every measure M30 computes, with its activation FY (§1.1). HCI
 * indicators + composite, HVLDL, and the operational measures activate FY2025; the HOPE-derived TFP
 * measures activate FY2028 (D4). CAHPS composite computes on calendar quarters (D14).
 */
export const MEASURE_CATALOG: readonly MeasureCatalogEntry[] = [
  // HCI — ten indicators + composite (FY2025).
  {
    code: "hci_indicator_01",
    family: "hci",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "HCI 1 — Continuous Home Care or General Inpatient provided",
  },
  {
    code: "hci_indicator_02",
    family: "hci",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "HCI 2 — Gaps in Skilled Nursing visits",
  },
  {
    code: "hci_indicator_03",
    family: "hci",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "HCI 3 — Early Live Discharges",
  },
  {
    code: "hci_indicator_04",
    family: "hci",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "HCI 4 — Late Live Discharges",
  },
  {
    code: "hci_indicator_05",
    family: "hci",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "HCI 5 — Burdensome Transitions Type 1",
  },
  {
    code: "hci_indicator_06",
    family: "hci",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "HCI 6 — Burdensome Transitions Type 2",
  },
  {
    code: "hci_indicator_07",
    family: "hci",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "HCI 7 — Per-beneficiary Medicare spending",
  },
  {
    code: "hci_indicator_08",
    family: "hci",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.2.0",
    description: "HCI 8 — Skilled Nursing Minutes per RHC day",
  },
  {
    code: "hci_indicator_09",
    family: "hci",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.2.0",
    description: "HCI 9 — Skilled Nursing Minutes on Weekends",
  },
  {
    code: "hci_indicator_10",
    family: "hci",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "HCI 10 — Visits Near Death",
  },
  {
    code: "hci_composite",
    family: "hci",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "Hospice Care Index composite score (0–10)",
  },
  // HVLDL (FY2025).
  {
    code: "hvldl",
    family: "hvldl",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.3.0",
    description: "Hospice Visits in Last Days of Life",
  },
  // HOPE-derived (FY2028).
  {
    code: "tfp_pi",
    family: "hope_derived",
    periodKind: ROLLING,
    activatesFy: 2028,
    calculatorVersion: "0.1.0",
    description: "Timely Follow-Up for Pain Impact",
  },
  {
    code: "tfp_npsi",
    family: "hope_derived",
    periodKind: ROLLING,
    activatesFy: 2028,
    calculatorVersion: "0.1.0",
    description: "Timely Follow-Up for Non-Pain Symptom Impact",
  },
  // Operational (FY2025).
  {
    code: "verbal_order_signature_on_time",
    family: "operational",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "Verbal-order signature on time (CoP 418.104(b))",
  },
  {
    code: "idg_cadence_adherence",
    family: "operational",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "IDG cadence adherence (CoP 418.56)",
  },
  {
    code: "care_plan_15_day_adherence",
    family: "operational",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "Care-plan 15-day adherence (CoP 418.56)",
  },
  {
    code: "supervisory_visit_on_time",
    family: "operational",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "Supervisory visit on time (CoP 418.76)",
  },
  {
    code: "bereavement_coverage_rate",
    family: "operational",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "Bereavement coverage rate (CoP 418.64(d))",
  },
  {
    code: "volunteer_compliance_gate_rate",
    family: "operational",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "Volunteer compliance gate rate (CoP 418.78)",
  },
  {
    code: "evv_compliance_rate",
    family: "operational",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "EVV compliance rate (Cures Act §12006)",
  },
  {
    code: "visit_on_time_rate",
    family: "operational",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "Visit on-time rate",
  },
  {
    code: "missed_dose_rate",
    family: "operational",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "Missed-dose rate",
  },
  {
    code: "prn_effectiveness_documented_rate",
    family: "operational",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "PRN effectiveness documented rate",
  },
  {
    code: "comfort_kit_deployment_to_admin_minutes",
    family: "operational",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "Comfort-kit deployment-to-administration interval",
  },
  {
    code: "opioid_on_admission_rate",
    family: "operational",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "Opioid-on-admission rate (informational)",
  },
  {
    code: "late_encounter_entry_rate",
    family: "operational",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "Late-encounter-entry rate",
  },
  {
    code: "hope_submission_acceptance_rate",
    family: "operational",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "HOPE submission acceptance rate (HQRP/APU)",
  },
  {
    code: "hope_sfv_on_time_rate",
    family: "operational",
    periodKind: ROLLING,
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "HOPE SFV on-time rate (HQRP)",
  },
  {
    // GAP-065 — the CoP 418.310 failure-to-file indicator the M27 forward seam was built to feed. It
    // computes on a CALENDAR YEAR, not the rolling-12m-to-quarter window every other operational measure
    // uses: cost-report filing is an annual obligation, and its source (`filingStatusForOrg`) is a
    // point-in-time posture rather than a windowed event count.
    code: "cost_report_filing_compliance",
    family: "operational",
    periodKind: "calendar_year",
    activatesFy: 2025,
    calculatorVersion: "0.1.0",
    description: "Cost-report filing compliance (CoP 418.310)",
  },
];

/** All catalog entries ACTIVE at/under `fiscalYear` (i.e. `activatesFy <= fiscalYear`). Pure. */
export function listMeasureCatalog(fiscalYear: number): MeasureCatalogEntry[] {
  return MEASURE_CATALOG.filter((entry) => entry.activatesFy <= fiscalYear);
}

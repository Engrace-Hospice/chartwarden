// @wardenx/emar — §2.4 D3 PRN reassessment trigger (M13-T04). PURE, IO-free, `Date.now()`-free.
//
// A PRN administration is a `single_dose`-mode `administration_record` linked 1:1 to a `prn_administration`
// row. On commit, M13 emits `m13.prn_administration_recorded` carrying the reassessment-due deadline and a
// recommended scale; M9 subscribes (§4.5) and presents the chart UI with that scale pre-selected, then runs
// the `prn-reassessment-overdue` cron and owns the M36 alert. M13's role ends at the trigger emission (D3):
// the reassessment *scale* (PPS/PAINAD/ESAS-r) is M9's domain, so M13 only RECOMMENDS one by clinical
// category — it never scores. This module is pure: the clinical category (resolved via M38 upstream), the
// order/tenant window defaults, and `administeredAt` are all injected, so the deadline + payload are
// deterministic and unit-testable with no DB and no clock (the M11/M12 lifecycle precedent).
import type {
  AdministrationRecordId,
  AdmissionId,
  IsoInstant,
  MedicationOrderId,
  PatientId,
  PrnAdministrationId,
} from "@wardenx/types";

/**
 * §2.4 — the medication's clinical category, resolved upstream via M38 (RxNorm/NDC → therapeutic class).
 * Drives both the recommended reassessment scale and the per-category default reassessment window. `other`
 * is the catch-all (no specific scale recommendation; the tenant/default window applies).
 */
export type PrnClinicalCategory =
  | "analgesic" // breakthrough pain → ESAS-r pain; short window
  | "antipsychotic" // agitation/dementia → PAINAD or agitation-observed; long (sedating) window
  | "anxiolytic" // anxiety → ESAS-r anxiety item; long (sedating) window
  | "antiemetic" // nausea → ESAS-r nausea item
  | "other";

/** §2.4 — the recommended reassessment scale + optional focus item (e.g. ESAS-r's `anxiety`/`nausea` item).
 * `scale` matches `prn_administration.recommended_reassessment_scale` (text); M9 owns the actual scoring. */
export interface RecommendedReassessmentScale {
  /** The scale id (`esas_r` | `painad` | `agitation_observed`), or null when no specific scale applies. */
  readonly scale: string | null;
  /** The within-scale focus item (e.g. `anxiety`, `nausea` for ESAS-r), or null for a whole-scale score. */
  readonly item: string | null;
}

/** §2.4 — the per-category default reassessment window (minutes) when the order doesn't specify and the
 * tenant has no default. Sedatives reassess later (120); breakthrough-pain analgesics sooner (30). */
export const DEFAULT_REASSESSMENT_WINDOW_MINUTES = 60;
export const REASSESSMENT_WINDOW_DEFAULT_BY_CATEGORY: Readonly<Record<PrnClinicalCategory, number>> = {
  analgesic: 30,
  antipsychotic: 120,
  anxiolytic: 120,
  antiemetic: 60,
  other: DEFAULT_REASSESSMENT_WINDOW_MINUTES,
} as const;

/**
 * §2.4 — derive the recommended reassessment scale from the medication's clinical category. Antipsychotics
 * recommend `painad` when the patient has a dementia context (PAINAD is the dementia pain/behavior scale),
 * else `agitation_observed`. Anxiolytics/antiemetics map to the ESAS-r anxiety/nausea items. Analgesics map
 * to the whole ESAS-r (pain). `other` recommends nothing — M9 lets the clinician choose.
 */
export function recommendReassessmentScale(
  category: PrnClinicalCategory,
  options: { readonly hasDementiaContext?: boolean } = {},
): RecommendedReassessmentScale {
  switch (category) {
    case "analgesic":
      return { scale: "esas_r", item: "pain" };
    case "antipsychotic":
      return options.hasDementiaContext
        ? { scale: "painad", item: null }
        : { scale: "agitation_observed", item: null };
    case "anxiolytic":
      return { scale: "esas_r", item: "anxiety" };
    case "antiemetic":
      return { scale: "esas_r", item: "nausea" };
    case "other":
      return { scale: null, item: null };
  }
}

/**
 * §2.4 — resolve the reassessment window (minutes) by the documented precedence: the M12 order's
 * `sigStructured.prnPolicy.reassessmentWindowMinutes` wins; else the tenant default; else the per-category
 * default. A non-positive or non-finite candidate at any tier is ignored (falls through to the next tier).
 */
export function resolveReassessmentWindowMinutes(input: {
  readonly orderWindowMinutes?: number | null;
  readonly tenantDefaultMinutes?: number | null;
  readonly category: PrnClinicalCategory;
}): number {
  const valid = (n: number | null | undefined): n is number =>
    typeof n === "number" && Number.isFinite(n) && n > 0;
  if (valid(input.orderWindowMinutes)) return input.orderWindowMinutes;
  if (valid(input.tenantDefaultMinutes)) return input.tenantDefaultMinutes;
  return REASSESSMENT_WINDOW_DEFAULT_BY_CATEGORY[input.category];
}

/** §2.4 — the reassessment-due instant: `administeredAt + windowMinutes`. Pure (no clock). */
export function computeReassessmentDueAt(
  administeredAt: IsoInstant,
  windowMinutes: number,
): IsoInstant {
  return new Date(Date.parse(administeredAt) + windowMinutes * 60_000).toISOString();
}

/**
 * §2.4 — the `m13.prn_administration_recorded` outbox payload. M9 consumes it (§4.5) to pre-select the
 * recommended scale and arm its `prn-reassessment-overdue` cron. No PHI — only IDs + the deadline + the
 * recommended scale id (the `triggeringPrnReason` free-text stays on the row, denylisted; never in the event).
 */
export interface PrnReassessmentTrigger {
  readonly prnAdministrationId: PrnAdministrationId;
  readonly administrationRecordId: AdministrationRecordId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly medicationOrderId: MedicationOrderId;
  readonly administeredAt: IsoInstant;
  readonly reassessmentDueAt: IsoInstant;
  readonly reassessmentWindowMinutes: number;
  /** The recommended scale id (M9 pre-selects it); null when the category recommends none. */
  readonly recommendedScale: string | null;
  /** The within-scale focus item (e.g. `anxiety`); null for a whole-scale score or no recommendation. */
  readonly recommendedScaleItem: string | null;
}

/** The IDs + facts the service resolves at the PRN write to build the {@link PrnReassessmentTrigger}. */
export interface BuildPrnReassessmentTriggerInput {
  readonly prnAdministrationId: PrnAdministrationId;
  readonly administrationRecordId: AdministrationRecordId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly medicationOrderId: MedicationOrderId;
  readonly administeredAt: IsoInstant;
  readonly category: PrnClinicalCategory;
  readonly orderWindowMinutes?: number | null;
  readonly tenantDefaultMinutes?: number | null;
  readonly hasDementiaContext?: boolean;
}

/**
 * §2.4 D3 — assemble the full PRN reassessment trigger from the write-time facts: resolve the window
 * (order → tenant → category), compute the due instant, and recommend the scale. The service emits the
 * returned payload as `m13.prn_administration_recorded` in the administration commit transaction (the
 * `emit_prn_reassessment_trigger` side effect). Pure — every input is injected; deterministic.
 */
export function buildPrnReassessmentTrigger(
  input: BuildPrnReassessmentTriggerInput,
): PrnReassessmentTrigger {
  const reassessmentWindowMinutes = resolveReassessmentWindowMinutes({
    orderWindowMinutes: input.orderWindowMinutes,
    tenantDefaultMinutes: input.tenantDefaultMinutes,
    category: input.category,
  });
  const reassessmentDueAt = computeReassessmentDueAt(input.administeredAt, reassessmentWindowMinutes);
  const scale = recommendReassessmentScale(input.category, {
    hasDementiaContext: input.hasDementiaContext,
  });
  return {
    prnAdministrationId: input.prnAdministrationId,
    administrationRecordId: input.administrationRecordId,
    patientId: input.patientId,
    admissionId: input.admissionId,
    medicationOrderId: input.medicationOrderId,
    administeredAt: input.administeredAt,
    reassessmentDueAt,
    reassessmentWindowMinutes,
    recommendedScale: scale.scale,
    recommendedScaleItem: scale.item,
  };
}

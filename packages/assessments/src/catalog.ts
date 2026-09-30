// @wardenx/assessments — SCALE_CATALOG: per-scale metadata (§3.1, §5.2 families, D3 licensing).
//
// The single source the record-modal scale picker (T07), the timeline color families (§5.2), and the
// license-gate (D3) read. Per-scale SCORING/eligibility/thresholds live in `scales/<scale>/` (M9-T03);
// this catalog is metadata only (pure data, no scoring) so it ships type-clean at T01.

import { LICENSED_SCALE_TYPES, SCALE_TYPES } from "@wardenx/types";
import type { LicensedScaleType, ScaleType } from "@wardenx/types";

/** The §5.2 summary/timeline color family a scale belongs to (Performance / Symptoms / Risk / Cognitive). */
export type ScaleFamily = "performance" | "symptoms" | "risk" | "cognitive";

/** One scale's catalog entry: display metadata + the §5.2 family + the D3 license requirement. */
export interface ScaleCatalogEntry {
  readonly scaleType: ScaleType;
  /** Human label for the picker / timeline badge. */
  readonly label: string;
  /** The §5.2 family the summary view + timeline color-code by. */
  readonly family: ScaleFamily;
  /** True for the five proprietary scales whose recording is license-gated (D3, {@link LicensedScaleType}). */
  readonly licenseRequired: boolean;
}

const LICENSED: ReadonlySet<ScaleType> = new Set<ScaleType>(LICENSED_SCALE_TYPES);

/** The §5.2 family per scale (functional/prognostic → performance; symptom instruments → symptoms;
 * pressure-injury/fall risk → risk; staging/cognition/movement → cognitive). T07 reads this for the
 * timeline color families + summary grouping. */
const SCALE_FAMILY: { readonly [K in ScaleType]: ScaleFamily } = {
  pps: "performance",
  kps: "performance",
  nyha: "performance",
  meld: "performance",
  bode: "performance",
  flacker: "performance",
  esas_r: "symptoms",
  painad: "symptoms",
  flacc: "symptoms",
  braden: "risk",
  morse: "risk",
  fast: "cognitive",
  gds: "cognitive",
  aims: "cognitive",
};

/** Human labels per scale (the picker / timeline badge text). */
const SCALE_LABEL: { readonly [K in ScaleType]: string } = {
  pps: "PPS — Palliative Performance Scale",
  kps: "KPS — Karnofsky Performance Status",
  fast: "FAST — Functional Assessment Staging",
  painad: "PAINAD — Pain Assessment in Advanced Dementia",
  flacc: "FLACC — Face, Legs, Activity, Cry, Consolability",
  esas_r: "ESAS-r — Edmonton Symptom Assessment System (revised)",
  nyha: "NYHA — New York Heart Association Functional Class",
  meld: "MELD — Model for End-stage Liver Disease",
  bode: "BODE — BMI, Obstruction, Dyspnea, Exercise Index",
  flacker: "Flacker — Mortality Risk Index",
  gds: "GDS — Geriatric Depression Scale",
  braden: "Braden — Pressure-Injury Risk",
  morse: "Morse — Fall Risk Scale",
  aims: "AIMS — Abnormal Involuntary Movement Scale",
};

/** The catalog every scale resolves through (one entry per {@link ScaleType}, in §3.2 order). */
export const SCALE_CATALOG: { readonly [K in ScaleType]: ScaleCatalogEntry } = Object.fromEntries(
  SCALE_TYPES.map((scaleType) => [
    scaleType,
    {
      scaleType,
      label: SCALE_LABEL[scaleType],
      family: SCALE_FAMILY[scaleType],
      licenseRequired: LICENSED.has(scaleType),
    } satisfies ScaleCatalogEntry,
  ]),
) as { [K in ScaleType]: ScaleCatalogEntry };

/** Whether a scale requires a current (active or pending-renewal) license to record (D3 form-gating). */
export function isLicensedScale(scaleType: ScaleType): scaleType is LicensedScaleType {
  return LICENSED.has(scaleType);
}

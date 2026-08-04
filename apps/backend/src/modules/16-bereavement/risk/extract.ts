// apps/backend/src/modules/16-bereavement/risk/extract.ts — M16-T04 (§4.3.4 `extractRiskInputs`, D17).
//
// Resolve the cross-module EVIDENCE the D3/D17 rubric scores, through M1's seam registry only. M16 imports
// no M15 and no M9 schema: the MSW psychosocial findings arrive over M15's §4.3 `MswRiskFactorReader` and
// the pre-death trajectory over M9's §4.7 `ScaleSeriesProvider`. The derivation itself is the pure
// `deriveRiskFactors` in `@wardenx/bereavement` — this module is only the IO shell around it, which is what
// keeps the §7.13 survey reconstruction replayable from the captured vector alone.
//
// FAIL-SOFT, deliberately, and the OPPOSITE posture to the intake's fail-closed death fact. An unreadable
// seam here degrades that slice of evidence to `unknown` — never to `false`, and never to a thrown error:
//
//   • `unknown` is D17's whole point. A seam outage must widen the confidence band and shrink the
//     completeness, which is visible to the counselor and excluded from M30's denominator. Substituting
//     `false` would silently LOWER a grieving survivor's tier — the D17 rejected alternative (a).
//   • Throwing would be worse than a wrong score: the §2.2 `seedRosterAndSchedule` transition requires an
//     initial score (`INITIAL_RISK_SCORE_REQUIRED`), so an M9 outage would block the whole bereavement
//     program from opening. Compare the intake, where the fail direction is reversed because inventing a
//     death date mis-anchors a regulatory clock. Pick the fail direction by which error harms the survivor.
//
// KNOWN GAP, carried honestly: §7.3 sources `preExistingMentalHealth` from an M5 PrivacyFlag, but no bound
// seam exposes M5 privacy flags (`PatientReader` returns identity only). The factor therefore resolves from
// M15's MSW psychiatric-history findings alone; a `PrivacyFlagReader` would be an M5 forward seam, and until
// it exists an org whose only mental-health signal is the M5 flag scores that slot from the MSW record.
import type {
  BereavementRiskEvidence,
  BereavementRosterEvidence,
  DerivedRiskFactors,
} from "@wardenx/bereavement";
import { deriveRiskFactors } from "@wardenx/bereavement";
import type {
  AdmissionId,
  IsoInstant,
  MswRiskFactor,
  PatientId,
  ScaleSeriesPoint,
} from "@wardenx/types";
// Imported from ./consumed directly (not the seams barrel): the barrel now also exports the
// Drizzle seam store, which imports risk/score → risk/extract — a barrel import here is a cycle.
import { getMswRiskFactorReader, getScaleSeriesProvider } from "../seams/consumed";

/**
 * How far back the pre-death PPS series is windowed. The D3 question is whether the DEATH was foreseeable,
 * so the window must be long enough to contain a decline (§7.3's worked example is an admission of >180
 * days whose trajectory made the death expected) without dragging in a trajectory from a prior election.
 */
export const PPS_TRAJECTORY_WINDOW_DAYS = 180;

const MS_PER_DAY = 86_400_000;

/** What the caller must resolve before the evidence can be gathered. `sudDisclosureAllowed` is the READER's
 *  42 CFR Part 2 posture (§7.13) — it belongs to the request context, not to the plan. */
export interface RiskExtractionInput {
  readonly organizationId: string;
  readonly admissionId: AdmissionId;
  readonly patientId: PatientId;
  /** D4's anchor — the instant of death the PPS window ends at. */
  readonly deathAt: IsoInstant;
  /** The M16-owned roster facts for the survivor being scored (`null` members ⇒ roster not yet seeded). */
  readonly roster: BereavementRosterEvidence;
  /** §7.13 — false when M15's SQL filter already removed the SUD findings from this reader's view. */
  readonly sudDisclosureAllowed: boolean;
}

/** The evidence plus the per-source read outcome, so the caller can tell "no finding" from "no answer". */
export interface RiskEvidenceResult {
  readonly evidence: BereavementRiskEvidence;
  /** True when M15 answered (even with zero findings); false when the seam denied or threw. */
  readonly mswReadable: boolean;
  /** True when M9 answered; false when the seam denied or threw (⇒ `ppsPoints: null` ⇒ `unknown`). */
  readonly ppsReadable: boolean;
}

/** §4.3.4 — gather the cross-module evidence for one survivor's score. Never throws on a seam failure. */
export async function gatherRiskEvidence(input: RiskExtractionInput): Promise<RiskEvidenceResult> {
  const [msw, pps] = await Promise.all([readMswFactors(input), readPpsPoints(input)]);

  return {
    mswReadable: msw !== null,
    ppsReadable: pps !== null,
    evidence: {
      // Rule 1's discriminator. `MswRiskFactorReader` returns POSITIVE findings only, so a zero-row answer
      // cannot distinguish "the MSW assessed and documented every domain negative" from "no psychosocial
      // assessment exists" — and the conservative reading of that ambiguity is `unknown`, not `false`.
      // At least one finding proves an assessment happened, which is what makes the UNLISTED domains
      // documented negatives (§7.3); zero findings leaves every MSW slot `unknown` (§7.17).
      mswAssessed: msw !== null && msw.length > 0,
      mswFactors: msw ?? [],
      ppsPoints: pps,
      roster: input.roster,
      sudDisclosureAllowed: input.sudDisclosureAllowed,
    },
  };
}

/** §4.3.4 — the evidence gather + the pure D17 derivation, the shape the scorer consumes. */
export async function extractRiskInputs(input: RiskExtractionInput): Promise<DerivedRiskFactors> {
  const { evidence } = await gatherRiskEvidence(input);
  return deriveRiskFactors(evidence);
}

/** M15's §4.3 read. `null` = the seam denied or failed (deny-stub included) ⇒ MSW slots stay `unknown`. */
async function readMswFactors(
  input: RiskExtractionInput,
): Promise<readonly MswRiskFactor[] | null> {
  try {
    return await getMswRiskFactorReader().riskFactorsForAdmission(
      input.organizationId,
      input.admissionId,
    );
  } catch {
    return null;
  }
}

/** M9's §4.7 read over the pre-death window. `null` = the seam denied or failed ⇒ `suddenUnexpectedDeath`
 *  falls to rule 1's MSW fallback and then to `unknown`. */
async function readPpsPoints(
  input: RiskExtractionInput,
): Promise<readonly ScaleSeriesPoint[] | null> {
  const deathMs = Date.parse(input.deathAt);
  if (Number.isNaN(deathMs)) return null;
  const from = new Date(deathMs - PPS_TRAJECTORY_WINDOW_DAYS * MS_PER_DAY).toISOString();
  try {
    const series = await getScaleSeriesProvider().series(
      input.patientId,
      "pps",
      from,
      input.deathAt,
    );
    return series.points;
  } catch {
    return null;
  }
}

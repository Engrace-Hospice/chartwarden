// @chartwarden/bereavement — ADR-0109 D5: human-entered risk factors and how they merge with derived evidence.
//
// A counselor (route 28) or a pre-death assessor (the draft) can state some of the eight factors. They ride the
// evidence as `manualFactors` and merge into the derived vector with a rule that can only ever ADD knowledge:
//
//   true wins     a human `true` or a derived `true` stays `true` — carried-over evidence never silently lowers a
//                 computed risk (a documented `false` cannot erase an MSW finding);
//   false > unknown   a documented negative fills an `unknown` (that is the point of assessing);
//   otherwise     `unknown`.
//
// The substance-use factor is Part 2 content: it is merged only when the reader's disclosure allows it (the caller
// of `deriveRiskFactors` supplies `sudDisclosureAllowed`; a gated slot stays `unknown`, never `false`).
// PURE — no IO, `@chartwarden/types`-only.

import type {
  BereavementFactorValue,
  BereavementRiskFactorInputs,
  BereavementRiskFactorName,
} from "@chartwarden/types";

/** A partial factor vector a human supplied: only the slots they stated. */
export type ManualRiskFactors = Readonly<
  Partial<Record<BereavementRiskFactorName, BereavementFactorValue>>
>;

/**
 * The §4.2 wire keys (snake_case, as `RecomputeRiskBody.factors` and the pre-death draft spell them) → the rubric
 * factor names. One table, so the two request shapes and the stored vector cannot drift.
 */
export const RISK_FACTOR_WIRE_KEYS = {
  ambivalent_relationship: "ambivalentRelationship",
  sudden_unexpected_death: "suddenUnexpectedDeath",
  prior_unresolved_loss: "priorUnresolvedLoss",
  preexisting_mental_health: "preExistingMentalHealth",
  social_isolation: "socialIsolation",
  financial_strain: "financialStrain",
  primary_caregiver_role: "primaryCaregiverRole",
  active_substance_use: "activeSubstanceUse",
} as const satisfies Record<string, BereavementRiskFactorName>;

export type RiskFactorWireKey = keyof typeof RISK_FACTOR_WIRE_KEYS;

const WIRE_ENTRIES = Object.entries(RISK_FACTOR_WIRE_KEYS) as ReadonlyArray<
  readonly [RiskFactorWireKey, BereavementRiskFactorName]
>;

/** Wire object → rubric names. Only the keys present are mapped (a partial request stays partial). */
export function factorsFromWire(
  wire: Readonly<Partial<Record<RiskFactorWireKey, BereavementFactorValue>>>,
): ManualRiskFactors {
  const out: Partial<Record<BereavementRiskFactorName, BereavementFactorValue>> = {};
  for (const [wireKey, name] of WIRE_ENTRIES) {
    const value = wire[wireKey];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** Rubric vector → wire object (all eight keys). */
export function factorsToWire(
  factors: BereavementRiskFactorInputs,
): Record<RiskFactorWireKey, BereavementFactorValue> {
  return Object.fromEntries(
    WIRE_ENTRIES.map(([wireKey, name]) => [wireKey, factors[name]]),
  ) as Record<RiskFactorWireKey, BereavementFactorValue>;
}

/** The merge rule for one slot: true wins, then a documented false beats unknown. */
export function mergeFactorValue(
  a: BereavementFactorValue,
  b: BereavementFactorValue,
): BereavementFactorValue {
  if (a === true || b === true) return true;
  if (a === false || b === false) return false;
  return "unknown";
}

/** Merge two partial human vectors (a prior sticky one and a new one) slot by slot; returns a fresh object. */
export function mergeManualFactors(
  prior: ManualRiskFactors | undefined,
  next: ManualRiskFactors | undefined,
): ManualRiskFactors {
  const out: Partial<Record<BereavementRiskFactorName, BereavementFactorValue>> = { ...prior };
  for (const [name, value] of Object.entries(next ?? {}) as ReadonlyArray<
    readonly [BereavementRiskFactorName, BereavementFactorValue]
  >) {
    const held = out[name];
    out[name] = held === undefined ? value : mergeFactorValue(held, value);
  }
  return out;
}

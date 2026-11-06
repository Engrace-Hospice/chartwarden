// apps/backend/src/modules/16-bereavement/lifecycle/pre-death-draft.ts — ADR-0109 D5.
//
// The pure rules around `bereavement_risk_assessment_draft`: an MSW, chaplain or bereavement counselor on the care team (or
// oversight) records the eight D17 risk factors for an admission BEFORE the death. The draft is tri-state (default unknown),
// carries no free text, is writable only while no bereavement plan exists for the admission, and never holds a Part 2 value
// for a writer who is not cleared for one. At plan seed it is carried into the initial score and merged "true wins"
// (see `@chartwarden/bereavement` `manual-factors.ts`). No IO; the draft service applies these.
import {
  BEREAVEMENT_RISK_FACTOR_NAMES,
  type ManualRiskFactors,
  SUD_GATED_FACTOR,
} from "@chartwarden/bereavement";
import type {
  BereavementFactorValue,
  BereavementRiskFactorInputs,
  BereavementRiskFactorName,
} from "@chartwarden/types";
import { BereavementStateError } from "./errors";

/** The default draft: nothing stated about any of the eight factors. */
export const EMPTY_DRAFT_FACTORS: BereavementRiskFactorInputs = Object.freeze({
  ambivalentRelationship: "unknown",
  suddenUnexpectedDeath: "unknown",
  priorUnresolvedLoss: "unknown",
  preExistingMentalHealth: "unknown",
  socialIsolation: "unknown",
  financialStrain: "unknown",
  primaryCaregiverRole: "unknown",
  activeSubstanceUse: "unknown",
});

/**
 * The vector to STORE: the writer's eight tri-state values, with the substance-use slot forced to `unknown` unless the writer
 * is cleared for 42 CFR Part 2 content (the same disclosure verdict the risk reads use). Forced, not refused: a draft that
 * states "unknown" for a slot the writer may not see is the honest record, and the request still succeeds.
 */
export function draftFactorsForStorage(
  stated: BereavementRiskFactorInputs,
  sudAllowed: boolean,
): BereavementRiskFactorInputs {
  return sudAllowed ? { ...stated } : { ...stated, [SUD_GATED_FACTOR]: "unknown" };
}

const isTriState = (value: unknown): value is BereavementFactorValue =>
  value === true || value === false || value === "unknown";

/**
 * The vector to SHOW a reader, from the stored jsonb. Read defensively (the column is jsonb): a slot that is missing or not
 * tri-state reads `unknown`, never `false` — a malformed value must not turn into a documented negative. An uncleared reader
 * gets `unknown` for the Part 2 slot whatever is stored.
 */
export function draftFactorsForReader(
  stored: unknown,
  sudAllowed: boolean,
): BereavementRiskFactorInputs {
  const raw = (typeof stored === "object" && stored !== null ? stored : {}) as Record<
    string,
    unknown
  >;
  const out: Record<string, BereavementFactorValue> = {};
  for (const name of BEREAVEMENT_RISK_FACTOR_NAMES) {
    const value = raw[name];
    out[name] = isTriState(value) ? value : "unknown";
  }
  if (!sudAllowed) out[SUD_GATED_FACTOR] = "unknown";
  return out as unknown as BereavementRiskFactorInputs;
}

/** The draft is writable only while NO plan exists for the admission: once the death opens a plan the draft is carried
 *  into the initial score and is a closed record (409 `DRAFT_LOCKED`). */
export function assertDraftWritable(planExistsForAdmission: boolean): void {
  if (planExistsForAdmission) {
    throw new BereavementStateError(
      "DRAFT_LOCKED",
      "a bereavement plan already exists for this admission; the pre-death draft can no longer be edited",
    );
  }
}

/**
 * The stored draft as the manual factors the initial score merges: only the slots the assessor actually stated (`unknown`
 * is "not stated", so it contributes nothing). The Part 2 slot is gated again at the score, by the scoring reader's own
 * disclosure — a slot written by a cleared assessor is not carried into a score the platform may not disclose.
 */
export function draftFactorsAsManual(stored: unknown): ManualRiskFactors {
  const vector = draftFactorsForReader(stored, true);
  const out: Partial<Record<BereavementRiskFactorName, BereavementFactorValue>> = {};
  for (const name of BEREAVEMENT_RISK_FACTOR_NAMES) {
    if (vector[name] !== "unknown") out[name] = vector[name];
  }
  return out;
}

// apps/backend/src/modules/16-bereavement/risk/score.ts — M16-T04 (§4.3.3 `computeDeterministicRisk`, D3,
// D8, D17).
//
// Compose the pure halves into the APPEND-ONLY `bereavement_risk_score` row and its §2.6 side effects. The
// composition order is the D3 asymmetry made literal:
//
//   evidence ──► deriveRiskFactors ──► computeBereavementRiskScore ──► promoteTierForGriefScreen
//                                                     │                          │
//                                                     └── the tier ──────────────┴──► `rule_tier`
//                                                                   (the LLM path can only reach the
//                                                                    `augmented_*` columns, never here)
//
// D8: EVERY recompute — the scheduled intake / 1mo / 6mo / 12mo passes, a positive complicated-grief
// screen, an MSW or PPS update, a counselor override — appends a NEW row and never updates one. The M4
// trigger from M16-T02 refuses UPDATE on this table outright, so an amendment that tried to mutate would
// fail at the database, not at review. `amendmentKind` + `amendedFromScoreId` ride `risk_factors_jsonb`
// (the §3.3.3 columns are the forward-seam fields the spec names there), keeping the chain reconstructable.
//
// The row this module returns is NOT written here: the M16-T06 service layer inserts it inside the
// aggregate's optimistic-locked transaction alongside the M4 audit row and the §4.4 outbox row, so "the
// tier moved but `risk_score_computed` never went out" stays structurally impossible.
import type {
  BereavementRiskEvidence,
  BereavementScoredResult,
  DerivedRiskFactors,
} from "@chartwarden/bereavement";
import {
  DETERMINISTIC_AUGMENTATION_COLUMNS,
  RISK_TIER_OVERRIDE_REASON_MIN_LENGTH,
  computeBereavementRiskScore,
  deriveRiskFactors,
  promoteTierForGriefScreen,
  weightedScoreToRuleScore,
} from "@chartwarden/bereavement";
import type {
  BereavedContactId,
  BereavementPlanId,
  BereavementRiskTier,
  IsoInstant,
  M16RiskScoreComputedPayload,
} from "@chartwarden/types";
import { BereavementStateError } from "../lifecycle/index";
import type { BereavementSideEffect } from "../lifecycle/index";
import { type RiskExtractionInput, gatherRiskEvidence } from "./extract";

/** D8 — why this immutable row was appended. Rides `risk_factors_jsonb` (§3.3.3 forward-seam fields). */
export type BereavementAmendmentKind =
  /** The first score for a contact, at §7.2 roster seed. */
  | "initial"
  /** A D8 scheduled reassessment (intake / 1mo / 6mo / 12mo) or an evidence-change recompute. */
  | "scheduled_reassessment"
  /** §7.7 — a positive PG-13/IPG-R screen promoted the tier to `complicated`. */
  | "complicated_grief_promotion"
  /** §7.3 — the counselor judged the rubric missed something; reason ≥40 chars, immutable amendment. */
  | "counselor_override";

/** The D8 grief-screen totals (§7.7). Both null on a routine recompute. */
export interface GriefScreenTotals {
  /** The PG-13-adapted total out of 52; at or above `COMPLICATED_GRIEF_SCREEN_THRESHOLD` (25) it promotes. */
  readonly pg13Score: number | null;
  /** The IPG-R total, captured for the record; it does not itself drive the D8 promotion. */
  readonly ipgrScore: number | null;
}

const NO_GRIEF_SCREEN: GriefScreenTotals = { pg13Score: null, ipgrScore: null };

/** What the scorer needs beyond the evidence: who/what the row is for, and why it is being appended. */
export interface RiskScoreRequest {
  readonly planId: BereavementPlanId;
  /** The survivor being scored; omit for the plan-level rollup row (`bereaved_contact_id IS NULL`). */
  readonly contactId?: BereavedContactId;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  /** The M2 membership behind the score; null for the cron / system scorer (§3.3.3). */
  readonly assessedByUserId: string | null;
  readonly assessedAt: IsoInstant;
  readonly amendmentKind: BereavementAmendmentKind;
  /** The row this one amends (D8's chain). Null on an `initial` score. */
  readonly amendedFromScoreId: string | null;
  readonly griefScreen?: GriefScreenTotals;
  /** §7.3 — required (≥40 chars) when `amendmentKind === 'counselor_override'`. */
  readonly amendmentReason?: string;
  /** §7.3 — the tier a counselor override lands on; the rubric's own tier is kept in the vector. */
  readonly overrideTier?: BereavementRiskTier;
  /** The tier this survivor carried before this row (`bereaved_contact.current_risk_tier`); null on the
   *  first score. Drives the §4.10 `risk_tier_escalated` alert — the only thing "escalated" can compare to. */
  readonly priorTier?: BereavementRiskTier | null;
}

/** The `risk_factors_jsonb` payload. Locked to `BereavementRiskFactorInputs` plus the D8 screen totals and
 *  the D17 provenance — the shape §7.13's survey reconstruction and §7.17's UI banner both read. */
export interface RiskFactorsJsonb {
  readonly factors: DerivedRiskFactors["factors"];
  readonly pg13Score: number | null;
  readonly ipgrScore: number | null;
  /** §7.13 — the disclosure categories filtered upstream; empty when the reader saw everything. */
  readonly redactedCategories: readonly string[];
  /** MSW findings with no D17 rubric slot — recorded, never weighted. */
  readonly unmappedMswFactors: readonly string[];
  readonly amendmentKind: BereavementAmendmentKind;
  readonly amendedFromScoreId: string | null;
  readonly amendmentReason: string | null;
  /** The rubric's OWN tier, preserved when a counselor override moved `rule_tier` off it. */
  readonly deterministicTier: BereavementRiskTier;
  /** True when a seam was unreadable, so the `unknown`s are an outage rather than an unasked question. */
  readonly evidenceDegraded: boolean;
}

/** The INSERT payload for one immutable `bereavement_risk_score` row (§3.3.3 column names). */
export interface BereavementRiskScoreDraft {
  readonly planId: BereavementPlanId;
  readonly bereavedContactId: BereavedContactId | null;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly scoreKind: "rule_deterministic" | "llm_augmented";
  readonly assessedAt: IsoInstant;
  readonly assessedByUserId: string | null;
  readonly riskFactorsJsonb: RiskFactorsJsonb;
  /** The D17 weighted score scaled to the INTEGER column (0.51 → 51). */
  readonly ruleScore: number;
  readonly ruleTier: BereavementRiskTier;
  readonly dataCompleteness: BereavementScoredResult["dataCompleteness"];
  readonly confidenceBand: BereavementScoredResult["confidenceBand"];
  readonly augmentedScore: number | null;
  readonly augmentedTier: BereavementRiskTier | null;
  readonly augmentedNarrativeRedacted: string | null;
  readonly augmentedModelRef: string | null;
  readonly augmentedRequestId: string | null;
}

/** The scorer's full result: the row to append, the effects to run with it, and the intermediate the
 *  counselor UI renders (the raw 0..1 score, the factor vector, the bands). */
export interface BereavementRiskScoreResult {
  readonly draft: BereavementRiskScoreDraft;
  readonly scored: BereavementScoredResult;
  readonly derived: DerivedRiskFactors;
  readonly effects: readonly BereavementSideEffect[];
}

/**
 * §4.3.3 — the deterministic scorer over ALREADY-RESOLVED evidence. PURE (given its inputs): no IO, so the
 * §9.1 unit tests and a surveyor replaying `risk_factors_jsonb` reach the same tier.
 *
 * Tier resolution, in order: the rubric's weighted-sum tier → the D8 grief-screen promotion (one-directional
 * — a negative screen never demotes) → a documented counselor override. An override that fails the §2.5
 * 40-character floor raises `RISK_OVERRIDE_REASON_TOO_SHORT` rather than landing an unexplained tier.
 */
export function computeDeterministicRisk(
  evidence: BereavementRiskEvidence,
  request: RiskScoreRequest,
  evidenceDegraded = false,
): BereavementRiskScoreResult {
  const derived = deriveRiskFactors(evidence);
  const scored = computeBereavementRiskScore(derived.factors);
  const screen = request.griefScreen ?? NO_GRIEF_SCREEN;

  const promoted = promoteTierForGriefScreen(scored.tier, screen.pg13Score);
  const ruleTier = resolveOverride(promoted, request);

  const draft: BereavementRiskScoreDraft = {
    planId: request.planId,
    bereavedContactId: request.contactId ?? null,
    providerEntityId: request.providerEntityId,
    locationId: request.locationId,
    assessedAt: request.assessedAt,
    assessedByUserId: request.assessedByUserId,
    ruleScore: weightedScoreToRuleScore(scored.weightedScore),
    ruleTier,
    dataCompleteness: scored.dataCompleteness,
    confidenceBand: scored.confidenceBand,
    riskFactorsJsonb: {
      factors: derived.factors,
      pg13Score: screen.pg13Score,
      ipgrScore: screen.ipgrScore,
      redactedCategories: derived.redactedCategories,
      unmappedMswFactors: derived.unmappedMswFactors,
      amendmentKind: request.amendmentKind,
      amendedFromScoreId: request.amendedFromScoreId,
      amendmentReason: request.amendmentReason ?? null,
      deterministicTier: scored.tier,
      evidenceDegraded,
    },
    // The Layer-2 columns start empty on EVERY row; `augmentation.ts` is the only writer, and only after
    // the `ai.full` ladder clears. `score_kind` is the deterministic discriminator until then.
    ...DETERMINISTIC_AUGMENTATION_COLUMNS,
  };

  return { draft, scored, derived, effects: effectsFor(draft, request.priorTier ?? null) };
}

/** §4.3.3 + §4.3.4 — resolve the evidence through the seams, then score it. The entry point the §2.2
 *  `recompute_risk` effect and the D8 reassessment worker (M16-T06) call. */
export async function scoreBereavementRisk(
  input: RiskExtractionInput,
  request: RiskScoreRequest,
): Promise<BereavementRiskScoreResult> {
  const { evidence, mswReadable, ppsReadable } = await gatherRiskEvidence(input);
  return computeDeterministicRisk(evidence, request, !mswReadable || !ppsReadable);
}

/** The §4.4 outbox payload for an appended row. `scoreId` is stamped by the caller after the INSERT
 *  returns it — the pure scorer cannot know a database-generated id. */
export function riskScoreComputedPayload(
  draft: BereavementRiskScoreDraft,
  scoreId: string,
): M16RiskScoreComputedPayload {
  return {
    planId: draft.planId,
    ...(draft.bereavedContactId === null ? {} : { contactId: draft.bereavedContactId }),
    scoreKind: draft.scoreKind,
    tier: draft.ruleTier,
    scoreId,
    dataCompleteness: draft.dataCompleteness,
    confidenceBand: draft.confidenceBand,
  };
}

/** The tier ladder above the rubric: the §7.3 counselor override. Validated, never silent. */
function resolveOverride(
  promotedTier: BereavementRiskTier,
  request: RiskScoreRequest,
): BereavementRiskTier {
  if (request.amendmentKind !== "counselor_override") return promotedTier;
  const reason = request.amendmentReason ?? "";
  if (reason.trim().length < RISK_TIER_OVERRIDE_REASON_MIN_LENGTH) {
    throw new BereavementStateError(
      "RISK_OVERRIDE_REASON_TOO_SHORT",
      `a counselor risk-tier override must document at least ${RISK_TIER_OVERRIDE_REASON_MIN_LENGTH} characters of reason`,
    );
  }
  if (request.overrideTier === undefined) {
    throw new BereavementStateError(
      "RISK_OVERRIDE_TIER_REQUIRED",
      "a counselor risk-tier override must name the tier it lands on",
    );
  }
  return request.overrideTier;
}

/**
 * §2.6 — the side effects that commit with the row. Every append emits `risk_score_computed` (M30's
 * screening measure and M33's distribution both read it); a tier that ESCALATED additionally raises the
 * §4.10 `risk_tier_escalated` alert so the counselor is told rather than left to notice.
 *
 * The §7.7 complicated-grief referral (`contact_referred_external` + the M22 referral letter) is NOT emitted
 * here: it is the `flagComplicatedGrief` transition on the §2.3 contact machine, which owns the state change
 * this score row only records.
 */
function effectsFor(
  draft: BereavementRiskScoreDraft,
  priorTier: BereavementRiskTier | null,
): readonly BereavementSideEffect[] {
  const effects: BereavementSideEffect[] = [
    { kind: "audit" },
    { kind: "outbox", event: "m16.bereavement.risk_score_computed" },
  ];
  // No prior tier means this is the first score — a starting point, not an escalation.
  if (priorTier !== null && TIER_RANK[draft.ruleTier] > TIER_RANK[priorTier]) {
    effects.push({ kind: "alert", alert: "risk_tier_escalated" });
  }
  return effects;
}

/** Tier severity order — the only thing "escalated" can mean. */
const TIER_RANK: { readonly [K in BereavementRiskTier]: number } = {
  low: 0,
  moderate: 1,
  high: 2,
  complicated: 3,
};

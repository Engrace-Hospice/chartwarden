// @wardenx/bereavement — D3 Layer-2 risk-narrative eligibility (M16-T04).
//
// D3 is a HYBRID model with a hard asymmetry: the deterministic rubric owns the tier, and the M32 LLM adds
// clinical prose that can never move it (AI Governance §7.4; the spec's rejected alternative (c) is exactly
// "LLM-can-change-tier"). This module is the gate in front of that second layer, and
// {@link mergeAugmentation} is the structural enforcement of the asymmetry — the augmented score/tier land
// in their OWN columns and the caller is handed back the deterministic tier unchanged.
//
// Phase-1 posture: `ai.full` is a Part-A capability flag that is OFF for every tenant, so the ladder's only
// reachable arm today is a refusal and the score row stays `rule_deterministic`. Same shape as M8's
// `hearthnote.layer2` deny-stub (packages/hearthnote/src/layer2) — the ladder is real, shipped and tested
// now; only the M32 call behind it is pending.
//
// PURE — no IO, `@wardenx/types`-only.

import type {
  BereavementAugmentationResult,
  BereavementDataCompleteness,
  BereavementRiskScoreKind,
  BereavementRiskTier,
} from "@wardenx/types";

/** The Part-A capability that unlocks the Layer-2 narrative (M38's `ai.full` precedent). Default OFF. */
export const BEREAVEMENT_AI_FULL_FLAG = "ai.full" as const;

/** Why the Layer-2 narrative did not run, or `eligible` when every gate passed. */
export type BereavementLayer2Reason =
  /** `ai.full` is off for the tenant — the Phase-1 default and the outermost gate. */
  | "capability_disabled"
  /** The tenant has not opted into the bereavement risk narrative specifically. */
  | "tenant_flag_off"
  /** M32 is not bound in this deployment (the seam is still a deny-stub). */
  | "m32_unbound"
  /** The vendor BAA is not executed — PHI may not leave the boundary (architecture §25.14). */
  | "baa_not_executed"
  /** D17 — a `minimal` vector is advisory-only; clinical prose over ≤3 knowable factors would read as
   *  more certain than the evidence is, which is the §17 reproducibility risk the band exists to flag. */
  | "insufficient_data"
  | "eligible";

/** The per-tenant / per-deployment facts the ladder reads. All injected — this module resolves nothing. */
export interface BereavementLayer2Eligibility {
  /** The `ai.full` capability for this org. */
  readonly aiFull: boolean;
  /** The tenant opted into the bereavement risk narrative (§7.3 "tenant Layer 2 narrative opt-in flag"). */
  readonly tenantNarrativeOptIn: boolean;
  /** M32's narrative capability is bound (not the M1 deny-stub). */
  readonly m32Bound: boolean;
  /** The M34 vendor BAA is executed for this tenant. */
  readonly baaExecuted: boolean;
  /** The D17 band on the vector about to be narrated. */
  readonly dataCompleteness: BereavementDataCompleteness;
}

/** Evaluate the ladder, returning the FIRST failing gate in priority order (outermost first). */
export function evaluateBereavementLayer2Eligibility(
  e: BereavementLayer2Eligibility,
): BereavementLayer2Reason {
  if (!e.aiFull) return "capability_disabled";
  if (!e.tenantNarrativeOptIn) return "tenant_flag_off";
  if (!e.m32Bound) return "m32_unbound";
  if (!e.baaExecuted) return "baa_not_executed";
  if (e.dataCompleteness === "minimal") return "insufficient_data";
  return "eligible";
}

/** True when {@link evaluateBereavementLayer2Eligibility} cleared every gate. */
export function isBereavementLayer2Eligible(e: BereavementLayer2Eligibility): boolean {
  return evaluateBereavementLayer2Eligibility(e) === "eligible";
}

/** The Layer-2 columns of a `bereavement_risk_score` row, plus the `score_kind` discriminator. The
 *  deterministic `rule_score`/`rule_tier` are deliberately NOT in this shape: they are not mergeable. */
export interface BereavementAugmentationColumns {
  readonly scoreKind: BereavementRiskScoreKind;
  readonly augmentedScore: number | null;
  readonly augmentedTier: BereavementRiskTier | null;
  readonly augmentedNarrativeRedacted: string | null;
  readonly augmentedModelRef: string | null;
  readonly augmentedRequestId: string | null;
}

/** The `rule_deterministic` shape — what every score row is until (and unless) M32 answers. */
export const DETERMINISTIC_AUGMENTATION_COLUMNS: BereavementAugmentationColumns = {
  scoreKind: "rule_deterministic",
  augmentedScore: null,
  augmentedTier: null,
  augmentedNarrativeRedacted: null,
  augmentedModelRef: null,
  augmentedRequestId: null,
} as const;

/**
 * AI Governance §7.4 — fold an M32 result into the row's Layer-2 columns. The augmented tier is recorded as
 * ADVISORY NARRATIVE CONTEXT in `augmented_tier` and is never allowed to reach `rule_tier`; the caller
 * therefore gets the deterministic tier back verbatim in {@link MergedAugmentation.tier}. This function is
 * the only supported way to build the columns, so "the LLM moved the tier" has no code path to take.
 *
 * The §3.3.3 CHECK (`berv_risk_llm_requires_rule`) additionally refuses an `llm_augmented` row without both
 * `augmented_score` and `augmented_model_ref` — a null augmented score degrades to the deterministic shape
 * here rather than producing a row PostgreSQL would reject.
 */
export interface MergedAugmentation {
  readonly columns: BereavementAugmentationColumns;
  /** The DETERMINISTIC tier — unchanged, whatever the narrative said. */
  readonly tier: BereavementRiskTier;
}

export function mergeAugmentation(
  deterministicTier: BereavementRiskTier,
  augmentation: BereavementAugmentationResult | null,
): MergedAugmentation {
  if (augmentation === null || augmentation.augmentedScore === null || !augmentation.modelRef) {
    return { columns: DETERMINISTIC_AUGMENTATION_COLUMNS, tier: deterministicTier };
  }
  return {
    tier: deterministicTier,
    columns: {
      scoreKind: "llm_augmented",
      augmentedScore: augmentation.augmentedScore,
      augmentedTier: augmentation.augmentedTier,
      augmentedNarrativeRedacted: augmentation.narrative,
      augmentedModelRef: augmentation.modelRef,
      augmentedRequestId: augmentation.requestId,
    },
  };
}

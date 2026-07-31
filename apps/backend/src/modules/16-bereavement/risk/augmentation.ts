// apps/backend/src/modules/16-bereavement/risk/augmentation.ts — M16-T04 (§4.3 `requestAugmentedRisk`, D3
// Layer 2, AI Governance §7.4 / §17).
//
// The Layer-2 clinical-prose narrative, gated on the Part-A `ai.full` capability. Phase-1 posture, and the
// reason this file is a deny-stub rather than a call: `ai.full` is OFF for every tenant and M32 is not bound,
// so `requestAugmentedRisk` evaluates the real eligibility ladder, never leaves the process, and returns the
// deterministic row untouched. The M8 `hearthnote.layer2` precedent verbatim (packages/hearthnote/src/layer2)
// — ship the ladder now, wire the vendor adapter when M32 lands.
//
// Three properties this module exists to guarantee, in descending order of how badly their absence would
// hurt:
//
//   1. THE NARRATIVE CANNOT MOVE THE TIER. `mergeAugmentation` writes the LLM's score/tier into the
//      `augmented_*` columns and hands back the deterministic tier verbatim; `rule_tier` has no code path
//      from here. AI Governance §7.4's rejected alternative (c) is "LLM-can-change-tier", and the way to
//      reject it is structurally, not by convention.
//   2. NO PHI LEAVES WITHOUT THE LADDER. `ai.full` off, tenant opt-in off, M32 unbound, BAA not executed —
//      each is a hard stop BEFORE a request is composed, so a misconfiguration degrades to a deterministic
//      row rather than to an un-BAA'd vendor call (architecture §25.14: no module calls a model vendor SDK
//      directly; M32 owns the adapter).
//   3. FAILURE IS NOT A BLOCKER. A refused or failed augmentation returns the deterministic result with the
//      reason attached. The score is already complete without it — Layer 2 adds prose, never the decision.
import type { BereavementLayer2Reason } from "@wardenx/bereavement";
import {
  BEREAVEMENT_AI_FULL_FLAG as AI_FULL_FLAG,
  evaluateBereavementLayer2Eligibility,
  mergeAugmentation,
} from "@wardenx/bereavement";
import type { BereavementAugmentationResult, BereavementRiskTier } from "@wardenx/types";
import type { BereavementRiskScoreDraft, BereavementRiskScoreResult } from "./score";

/** Resolves an org's feature flags. Structurally M1's `FeatureFlagReader`; absent ⇒ every flag off, which
 *  is the Phase-1 default and the fail-closed reading. */
export interface BereavementFeatureFlagReader {
  forOrg(orgId: string): Promise<Record<string, boolean>>;
}

/** The M32 narrative capability, injected. Absent means M32 is not bound in this deployment — M16 imports
 *  no vendor SDK and no M32 code; the port is all it knows (ADR-0005 D1). */
export interface BereavementNarrativeProvider {
  /** Compose the Layer-2 clinical prose for an already-scored, already-persisted-shaped vector. */
  narrate(input: {
    readonly organizationId: string;
    readonly draft: BereavementRiskScoreDraft;
  }): Promise<BereavementAugmentationResult>;
}

/** The tenant-side facts the ladder reads that are not feature flags. */
export interface BereavementAugmentationContext {
  readonly organizationId: string;
  /** §7.3 — the tenant opted into the bereavement risk narrative specifically. */
  readonly tenantNarrativeOptIn: boolean;
  /** The M34 vendor BAA is executed for this tenant (architecture §25.14 / M08-F01 precedent). */
  readonly baaExecuted: boolean;
}

/** Everything the adapter may use. Both ports are optional: absent is the Phase-1 shape. */
export interface BereavementAugmentationDeps {
  readonly flags?: BereavementFeatureFlagReader;
  readonly narrative?: BereavementNarrativeProvider;
}

/** The adapter's outcome. `applied: false` always carries the ladder verdict — there is no silent skip. */
export interface AugmentedRiskResult {
  readonly result: BereavementRiskScoreResult;
  readonly applied: boolean;
  readonly reason: BereavementLayer2Reason;
  /** The DETERMINISTIC tier, restated so a caller cannot accidentally read the augmented one. */
  readonly tier: BereavementRiskTier;
}

/**
 * §4.3 `requestAugmentedRisk` — run the Layer-2 ladder over a deterministic result and, when every gate
 * clears AND M32 answers, fold the narrative into the row's `augmented_*` columns.
 *
 * Falls back to the deterministic-only row on every refusal AND on an M32 throw: the deterministic score is
 * the product, so a narrative failure must never cost the counselor their tier.
 */
export async function requestAugmentedRisk(
  result: BereavementRiskScoreResult,
  context: BereavementAugmentationContext,
  deps: BereavementAugmentationDeps = {},
): Promise<AugmentedRiskResult> {
  const deterministicTier = result.draft.ruleTier;
  const narrator = deps.narrative;
  const flags = deps.flags ? await readFlags(deps.flags, context.organizationId) : {};

  const reason = evaluateBereavementLayer2Eligibility({
    aiFull: flags[AI_FULL_FLAG] === true,
    tenantNarrativeOptIn: context.tenantNarrativeOptIn,
    m32Bound: narrator !== undefined,
    baaExecuted: context.baaExecuted,
    dataCompleteness: result.draft.dataCompleteness,
  });
  if (reason !== "eligible" || narrator === undefined) {
    return { result, applied: false, reason, tier: deterministicTier };
  }

  let augmentation: BereavementAugmentationResult | null = null;
  try {
    augmentation = await narrator.narrate({
      organizationId: context.organizationId,
      draft: result.draft,
    });
  } catch {
    // M32 unreachable / refused. The deterministic row already stands on its own.
    return { result, applied: false, reason: "m32_unbound", tier: deterministicTier };
  }

  const merged = mergeAugmentation(deterministicTier, augmentation);
  if (merged.columns.scoreKind === "rule_deterministic") {
    // §3.3.3's `berv_risk_llm_requires_rule` CHECK would refuse a half-populated augmented row; the merge
    // already degraded it to the deterministic shape rather than handing PostgreSQL an invalid INSERT.
    return { result, applied: false, reason: "m32_unbound", tier: deterministicTier };
  }

  return {
    applied: true,
    reason: "eligible",
    tier: merged.tier,
    result: {
      ...result,
      // `ruleTier` is copied through untouched — property 1, in one line.
      draft: { ...result.draft, ...merged.columns, ruleTier: merged.tier },
    },
  };
}

/** The Part-A capability key. Re-exported so backend callers need one import. */
export { AI_FULL_FLAG };

/** A flag read that cannot throw — an unreachable flag store reads as all-off (fail-closed). */
async function readFlags(
  reader: BereavementFeatureFlagReader,
  orgId: string,
): Promise<Record<string, boolean>> {
  try {
    return await reader.forOrg(orgId);
  } catch {
    return {};
  }
}

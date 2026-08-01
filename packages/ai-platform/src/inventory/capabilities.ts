// @wardenx/ai-platform — §2.4 Phase-1 capability inventory (M32-T01).
//
// The `ai_capability` rows registered at lock time (D2). PURE DATA — spec T55 is what INSERTs them.
// The registry, not the code, is the source of truth at runtime; this file is the source of truth for
// what the registry starts as.
//
// THE COUNT. §2.4's table names fourteen capabilities and its closing paragraph adds "mortality /
// decline / falls-risk / level-of-care prediction", arriving at "14 + 4 prediction = 18 registered".
// That arithmetic counts mortality and decline as two capabilities. The ARCHITECTURE's own capability
// catalog (`docs/ai/capability-catalog.yaml`, which `arch:ai-governance` enforces) joins them into one
// entry, `mortality-decline-prediction`, and architecture wins over a module spec on conflict. So the
// prediction group resolves to THREE and this file registers SEVENTEEN. The fourth key is not invented:
// there is no authority that names it, and a fabricated `capability_key` would become a permanently
// dead registry row that every consumer's `getCapability()` misses. Recorded as a gap below.
//
// THE APPROVED SET. §2.4's lead sentence says "Only `hearthnote_layer2` reaches `APPROVED` Phase 1";
// its own table marks THREE rows APPROVED (`hearthnote_layer2`, `idg_layer2_polish`,
// `embeddings_clinical`) and its closing paragraph says "3 in `APPROVED`". Two against one — the table
// and the closer agree, so three it is. Also recorded as a gap.
//
// AND NONE OF IT IS ON. Phase-1 posture (Wave H plan) is `ai.full` OFF for every tenant, so an APPROVED
// row here still deny-stubs with reason `phase_1_capability_shell`. The lifecycle state says the
// governance gate is passed; the flag says whether the platform is serving.

import type {
  AiCapabilityRiskTier,
  AiPhase1CapabilityRegistration,
  AiPhase1InventoryGap,
} from "@wardenx/types";

/**
 * The seventeen capabilities registered at lock time.
 *
 * `defaultBackendKey: null` marks the five capabilities §2.4 routes to "tabular ML (XGBoost on
 * `local-ml-worker`)" — a SERVICE, not one of the backend keys §2.3 registers. See the
 * `tabular-ml-backend-unregistered` gap.
 */
export const AI_PHASE_1_CAPABILITIES: readonly AiPhase1CapabilityRegistration[] = [
  {
    capabilityKey: "hearthnote_layer2",
    displayName: "HearthNote Layer 2 Narrative Enhancement",
    riskTier: "high",
    phase1LifecycleState: "APPROVED",
    defaultBackendKey: "anthropic-claude-opus-4-7",
    consumerModules: ["m8", "m14", "m16"],
    governanceCatalogId: "hearthnote-layer-2",
    note: "The one capability §1 calls hot Phase 1 — the NarrativeEnhancementProvider seam M8 requires at boot. Its LOCAL route is separately blocked by M32-F02 until a Stage-3 eval and a calibration row exist.",
  },
  {
    capabilityKey: "idg_layer2_polish",
    displayName: "IDG Packet Cover Layer 2 Polish",
    riskTier: "high",
    phase1LifecycleState: "APPROVED",
    defaultBackendKey: "anthropic-claude-opus-4-7",
    consumerModules: ["m14"],
    governanceCatalogId: "hearthnote-idg-aggregation-layer-2",
    note: "Shares hearthnote_layer2's infrastructure but is published as a DISTINCT capability so a tenant can opt out per-meeting without losing encounter-note enhancement.",
  },
  {
    capabilityKey: "doclens_classify",
    displayName: "DocLens Document Type Classification",
    riskTier: "medium",
    phase1LifecycleState: "DESIGN_REVIEW",
    defaultBackendKey: "local-distilbert-classifier",
    consumerModules: ["m22"],
    governanceCatalogId: "doclens-classifier",
    note: "Phase-2 promotion target. Until then M22 returns 503 EXTRACTION_DISABLED.",
  },
  {
    capabilityKey: "doclens_extract",
    displayName: "DocLens Structured Field Extraction",
    riskTier: "high",
    phase1LifecycleState: "DESIGN_REVIEW",
    defaultBackendKey: "anthropic-claude-opus-4-7",
    consumerModules: ["m22"],
    governanceCatalogId: "doclens-extractor",
    note: "Phase-2 promotion target.",
  },
  {
    capabilityKey: "doclens_vision_verify",
    displayName: "DocLens High-Risk Field Vision Verification",
    riskTier: "high",
    phase1LifecycleState: "DESIGN_REVIEW",
    defaultBackendKey: "anthropic-claude-opus-4-7",
    consumerModules: ["m22"],
    governanceCatalogId: "doclens-vision-verification",
    note: "Phase-2 promotion target. The only capability whose default backend must carry the `vision` modality.",
  },
  {
    capabilityKey: "doclens_sud_detect",
    displayName: "DocLens SUD Indicator Detection",
    riskTier: "high",
    phase1LifecycleState: "DESIGN_REVIEW",
    defaultBackendKey: "anthropic-claude-opus-4-7",
    consumerModules: ["m22"],
    governanceCatalogId: null,
    note: "Phase-2 promotion target. No entry in the architecture capability catalog — a 42 CFR Part 2 detector that reaches APPROVED without one would be a governance gap, not just a bookkeeping one.",
  },
  {
    capabilityKey: "copilot_clinical",
    displayName: "Chart Copilot — Clinical Q&A",
    riskTier: "high",
    phase1LifecycleState: "PROPOSED",
    defaultBackendKey: "anthropic-claude-opus-4-7",
    consumerModules: [],
    governanceCatalogId: "ai-copilot-clinical",
    note: "Phase 2+. Direct UI surface, no consumer module — which is why the `caseload_or_scope` predicate M32 consumes from M3 matters: there is no upstream module enforcing chart scope for it.",
  },
  {
    capabilityKey: "copilot_admin",
    displayName: "Chart Copilot — Administrative Q&A",
    riskTier: "medium",
    phase1LifecycleState: "PROPOSED",
    defaultBackendKey: "anthropic-claude-haiku-4-5",
    consumerModules: [],
    governanceCatalogId: "ai-copilot-administrative",
    note: "Phase 2+. Direct UI surface.",
  },
  {
    capabilityKey: "embeddings_clinical",
    displayName: "Clinical Text Embedding",
    riskTier: "low",
    phase1LifecycleState: "APPROVED",
    defaultBackendKey: "local-bge-small-en",
    consumerModules: [],
    governanceCatalogId: "embeddings-generation",
    note: "APPROVED and operational, but with no Phase-1 consumer surface: it powers the semantic-search infrastructure M38 and M22 reach for later. Blocked from seeding by the `approved-non-llm-capability-needs-template` gap.",
  },
  {
    capabilityKey: "semantic_search_chart",
    displayName: "Chart-Scoped Semantic Search",
    riskTier: "medium",
    phase1LifecycleState: "PROPOSED",
    defaultBackendKey: "local-bge-small-en",
    consumerModules: [],
    governanceCatalogId: "semantic-search",
    note: "Phase 2+. Direct UI surface. Per D20 its index is per-tenant with organization_id leading the HNSW key — a shared index with an org filter was rejected as bypassable.",
  },
  {
    capabilityKey: "protocol_suggestion_oncall",
    displayName: "On-Call Triage Protocol Suggestion",
    riskTier: "high",
    phase1LifecycleState: "DESIGN_REVIEW",
    defaultBackendKey: "anthropic-claude-opus-4-7",
    consumerModules: ["m19"],
    governanceCatalogId: null,
    note: "Phase-2 promotion target. M19-T01 already declared the ProtocolSuggestionProvider seam in @wardenx/types; M32 implements it as a deny-stub, it does not re-declare it.",
  },
  {
    capabilityKey: "hospitalization_risk_30d",
    displayName: "30-Day Hospitalization Risk Prediction",
    riskTier: "high",
    phase1LifecycleState: "DESIGN_REVIEW",
    defaultBackendKey: null,
    consumerModules: ["m19", "m14", "m16"],
    governanceCatalogId: null,
    note: "Tabular ML (XGBoost on local-ml-worker) — no §2.3 backend key. The architecture §10 capability inventory lists it; the architecture's enforced catalog does not.",
  },
  {
    capabilityKey: "bereavement_risk_narrative",
    displayName: "Bereavement Risk Narrative Augmentation",
    riskTier: "medium",
    phase1LifecycleState: "DESIGN_REVIEW",
    defaultBackendKey: "anthropic-claude-opus-4-7",
    consumerModules: ["m16"],
    governanceCatalogId: null,
    note: "Phase-2 promotion target. M16 ships the deterministic D3/D17 score alone until this promotes — its `ai.full` ladder is already built against that expectation.",
  },
  {
    capabilityKey: "denial_outcome_prediction",
    displayName: "Denial Outcome / Appeal Probability Prediction",
    riskTier: "medium",
    phase1LifecycleState: "PROPOSED",
    defaultBackendKey: null,
    consumerModules: ["m25"],
    governanceCatalogId: null,
    note: "Phase 2+. Tabular ML (XGBoost on local-ml-worker) — no §2.3 backend key.",
  },
  {
    capabilityKey: "mortality_decline_prediction",
    displayName: "Mortality / Decline Prediction",
    riskTier: "high",
    phase1LifecycleState: "PROPOSED",
    defaultBackendKey: null,
    consumerModules: [],
    governanceCatalogId: "mortality-decline-prediction",
    note: "Registered so the registry is the source of truth; no Phase-1 consumer. Key and risk tier come from the architecture catalog, which joins mortality and decline into one capability.",
  },
  {
    capabilityKey: "falls_risk_prediction",
    displayName: "Falls Risk Prediction",
    riskTier: "high",
    phase1LifecycleState: "PROPOSED",
    defaultBackendKey: null,
    consumerModules: [],
    governanceCatalogId: "falls-risk-prediction",
    note: "Registered so the registry is the source of truth; no Phase-1 consumer. Key and risk tier come from the architecture catalog.",
  },
  {
    capabilityKey: "level_of_care_prediction",
    displayName: "Level of Care Prediction",
    riskTier: null,
    phase1LifecycleState: "PROPOSED",
    defaultBackendKey: null,
    consumerModules: [],
    governanceCatalogId: null,
    note: "Named by §2.4's prediction group and by the architecture §10 capability inventory (XGBoost; care plan + IDG surface), but absent from the enforced architecture catalog — so nothing states its risk tier. `ai_capability.risk_tier` is NOT NULL: unseedable until stated.",
  },
];

/** Index by `capability_key` — the join key `ai_prompt_template`, `ai_invocation` and every seam use. */
export const AI_PHASE_1_CAPABILITIES_BY_KEY: ReadonlyMap<string, AiPhase1CapabilityRegistration> =
  new Map(AI_PHASE_1_CAPABILITIES.map((c) => [c.capabilityKey, c]));

/** The three §2.4 marks APPROVED at lock time. Still refused in Phase 1 — `ai.full` is the outer gate. */
export const AI_PHASE_1_APPROVED_CAPABILITY_KEYS: readonly string[] = AI_PHASE_1_CAPABILITIES.filter(
  (c) => c.phase1LifecycleState === "APPROVED",
).map((c) => c.capabilityKey);

/** True when a capability key is one §2.4 registers. Fails CLOSED. */
export function isAiPhase1CapabilityKey(key: string): boolean {
  return AI_PHASE_1_CAPABILITIES_BY_KEY.has(key);
}

/**
 * The §3.2.1 governance booleans a capability's risk tier DECIDES rather than an author choosing.
 *
 * §2.1 states both rules: `tenant_opt_in_required` is "true for High-risk; default true", and
 * `clinical_review_required` is "true for High-risk capabilities". The defaults are deliberately
 * asymmetric — opt-in is required for EVERY tier (the column default is true and no tier turns it off),
 * while clinical review is a high-risk-only burden. A medium-risk capability that silently skipped
 * tenant opt-in would be the exact failure D17's gate exists to prevent.
 */
export function aiCapabilityGovernanceDefaults(riskTier: AiCapabilityRiskTier | null): {
  readonly tenantOptInRequired: boolean;
  readonly clinicalReviewRequired: boolean;
} {
  return {
    tenantOptInRequired: true,
    // `null` (tier unstated) resolves to the SAFE side: review required until someone states otherwise.
    clinicalReviewRequired: riskTier === null || riskTier === "high",
  };
}

/**
 * Where §2.3/§2.4 does not determine a value a NOT-NULL column needs, or contradicts itself or the
 * architecture. Carried as DATA rather than prose so the seed tasks (T55/T56) and a reviewer read the
 * same list, and so a test can assert the list has not silently grown.
 */
export const AI_PHASE_1_INVENTORY_GAPS: readonly AiPhase1InventoryGap[] = [
  {
    id: "prediction-capability-count-does-not-reconcile",
    blocks: [],
    detail:
      "§2.4 states '14 + 4 prediction = 18 registered', counting mortality and decline separately. The architecture's enforced catalog (docs/ai/capability-catalog.yaml) joins them into one `mortality-decline-prediction` entry, and architecture wins on conflict — so the prediction group is three and this inventory registers seventeen, not eighteen. No fourth key is invented; if a fourth prediction capability is intended, §2.4 must name it.",
  },
  {
    id: "approved-count-contradicts-lead-sentence",
    blocks: [],
    detail:
      "§2.4's lead sentence says only `hearthnote_layer2` reaches APPROVED Phase 1, while its own table and its closing paragraph both say three (adding `idg_layer2_polish` and `embeddings_clinical`). This inventory follows the table + closer. The distinction is not academic: `ai_capability_approved_has_template` (§3.2.1) constrains every APPROVED row.",
  },
  {
    id: "tabular-ml-backend-unregistered",
    blocks: [
      "hospitalization_risk_30d",
      "denial_outcome_prediction",
      "mortality_decline_prediction",
      "falls_risk_prediction",
      "level_of_care_prediction",
    ],
    detail:
      "§2.4 gives these a default backend of 'tabular ML (XGBoost on local-ml-worker)', which is a SERVICE, not one of the eight backend keys §2.3 registers. `ai_capability.default_backend_key` is NOT NULL, so T55 cannot seed these five rows until §2.3 registers a tabular-ML backend (kind='local', so `localLicenseCheck` will also demand license terms + an artifact reference for the model file).",
  },
  {
    id: "approved-non-llm-capability-needs-template",
    blocks: ["embeddings_clinical"],
    detail:
      "§2.1 says `ai_capability.current_prompt_template_key` is 'nullable for non-LLM capabilities', but §3.2.1's `ai_capability_approved_has_template` CHECK forbids NULL for any row at APPROVED or MONITORING. `embeddings_clinical` is both APPROVED and non-LLM, so the row as §2.4 specifies it cannot be INSERTed. Resolvable either by relaxing the CHECK to exempt non-LLM capabilities or by registering a degenerate template row; M32-T02 has to pick one and the choice is a schema decision, not a seed decision.",
  },
  {
    id: "level-of-care-risk-tier-unstated",
    blocks: ["level_of_care_prediction"],
    detail:
      "Neither §2.4, nor the architecture §10 capability inventory, nor the enforced architecture catalog states a risk tier for level-of-care prediction. `ai_capability.risk_tier` is NOT NULL. A guess here is load-bearing — the tier decides `clinical_review_required` and the AI Governance §4.2 evidence burden — so the field is null and the row is unseedable until stated.",
  },
  {
    id: "registry-and-architecture-catalog-are-not-one-to-one",
    blocks: [],
    detail:
      "Six of the seventeen capabilities have no architecture-catalog id (`doclens_sud_detect`, `protocol_suggestion_oncall`, `hospitalization_risk_30d`, `bereavement_risk_narrative`, `denial_outcome_prediction`, `level_of_care_prediction`), and the catalog's `aggregate-cap-projection` (module 26) is absent from §2.4. `arch:ai-governance` only checks the twelve architecture-listed ids, so nothing goes red — but the two registries are not the same set, and the AI Governance §4.1 catalog is meant to be the platform-wide one.",
  },
];

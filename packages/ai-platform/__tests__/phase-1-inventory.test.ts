// Module 32 — §2.3/§2.4 Phase-1 inventory (M32-T01).
//
// This inventory becomes `ai_capability` / `ai_model_backend` rows at seed time, so a wrong value here
// is a wrong registry, and a registry is what every routing decision, kill switch and §164.528
// accounting reads. The tests that matter most are the ones asserting where the spec is SILENT: a
// fabricated context window or risk tier would sail through review and only surface as a truncated
// prompt or a skipped clinical review months later.

import { describe, expect, it } from "vitest";

import {
  AI_PHASE_1_ACTIVE_BACKEND_KEYS,
  AI_PHASE_1_BACKENDS,
  AI_PHASE_1_BACKENDS_BY_KEY,
  isAiPhase1BackendKey,
} from "../src/inventory/backends";
import {
  AI_PHASE_1_APPROVED_CAPABILITY_KEYS,
  AI_PHASE_1_CAPABILITIES,
  AI_PHASE_1_CAPABILITIES_BY_KEY,
  AI_PHASE_1_INVENTORY_GAPS,
  aiCapabilityGovernanceDefaults,
  isAiPhase1CapabilityKey,
} from "../src/inventory/capabilities";

describe("§2.3 backend inventory", () => {
  it("registers the six §2.3 table rows, the two its closing paragraph adds, and ADR-0048's local vision route", () => {
    expect(AI_PHASE_1_BACKENDS).toHaveLength(9);
    expect(new Set(AI_PHASE_1_BACKENDS.map((b) => b.backendKey)).size).toBe(9);
  });

  it("registers `local-phi-3.5-mini` inactive for lifecycle continuity, and nothing else", () => {
    const inactive = AI_PHASE_1_BACKENDS.filter((b) => !b.isActive).map((b) => b.backendKey);
    expect(inactive).toEqual(["local-phi-3.5-mini"]);
    expect(AI_PHASE_1_ACTIVE_BACKEND_KEYS).toHaveLength(8);
    expect(AI_PHASE_1_ACTIVE_BACKEND_KEYS).not.toContain("local-phi-3.5-mini");
  });

  it("keys every cloud backend to a vendor with a BAA path and every local one to `local-`", () => {
    for (const backend of AI_PHASE_1_BACKENDS) {
      const prefix = backend.kind === "cloud" ? "anthropic-" : "local-";
      expect(backend.backendKey.startsWith(prefix)).toBe(true);
    }
    // §3.2.8's `zdrCheck` keys off the `anthropic-` prefix, so the naming is load-bearing, not cosmetic.
    expect(AI_PHASE_1_BACKENDS.filter((b) => b.kind === "cloud")).toHaveLength(2);
  });

  it("states a context window only where §2.3 states one", () => {
    const stated = Object.fromEntries(
      AI_PHASE_1_BACKENDS.map((b) => [b.backendKey, b.contextWindowTokens]),
    );
    // 1M — `claude-opus-4-7` is a 1M-context model. §2.3's table said 200K against an earlier Opus
    // generation; the table and this row were corrected together. Haiku 4.5 really is 200K.
    expect(stated["anthropic-claude-opus-4-7"]).toBe(1_000_000);
    expect(stated["anthropic-claude-haiku-4-5"]).toBe(200_000);
    expect(stated["local-llama-3.1-8b-instruct"]).toBe(128_000);
    expect(stated["local-mistral-7b-instruct"]).toBe(32_000);
    expect(stated["local-bge-small-en"]).toBe(512);
    expect(stated["local-distilbert-classifier"]).toBe(512);
    expect(stated["local-qwen2.5-vl-7b-instruct"]).toBe(32_768); // ADR-0048 (F-237)
    // The two rows §2.3's TABLE omits have no stated window. Guessing one would silently truncate a
    // real prompt, so they are null and declared unseedable instead.
    expect(stated["local-phi-3.5-mini"]).toBeNull();
    expect(stated["local-all-minilm-l6-v2"]).toBeNull();
  });

  it("declares a seed blocker for every field it left null", () => {
    for (const backend of AI_PHASE_1_BACKENDS) {
      if (backend.contextWindowTokens === null) {
        expect(backend.additionalSeedBlockers).toContain("contextWindowTokens");
      } else {
        expect(backend.additionalSeedBlockers).not.toContain("contextWindowTokens");
      }
    }
  });

  it("routes each modality to a backend that declares it", () => {
    const withModality = (m: string) =>
      AI_PHASE_1_BACKENDS.filter((b) => (b.supportedModalities as readonly string[]).includes(m));
    // Vision verification has a cloud home (Opus) and, since ADR-0048 (F-237), a local one; if both
    // lose `vision` the capability is dead.
    expect(withModality("vision").map((b) => b.backendKey)).toEqual([
      "anthropic-claude-opus-4-7",
      "local-qwen2.5-vl-7b-instruct",
    ]);
    expect(withModality("classification").map((b) => b.backendKey)).toEqual([
      "local-distilbert-classifier",
    ]);
    expect(withModality("embedding")).toHaveLength(2);
  });

  it("fails closed on an unregistered backend key", () => {
    expect(isAiPhase1BackendKey("anthropic-claude-opus-4-7")).toBe(true);
    expect(isAiPhase1BackendKey("anthropic-claude-opus-4-8")).toBe(false);
    expect(isAiPhase1BackendKey("")).toBe(false);
    expect(AI_PHASE_1_BACKENDS_BY_KEY.size).toBe(AI_PHASE_1_BACKENDS.length);
  });
});

describe("§2.4 capability inventory", () => {
  it("registers twenty: the seventeen the architecture catalog reconciles to, plus adr_documentation_readiness and the two M36 messaging capabilities (ADR-0095)", () => {
    // Historical: §2.4's own arithmetic reached 18 for the spec-era set by counting mortality and decline separately; the architecture's enforced
    // catalog joins them into one `mortality-decline-prediction` (architecture wins), giving 17; the 18th
    // here is the later-added adr_documentation_readiness, unrelated to that arithmetic.
    expect(AI_PHASE_1_CAPABILITIES).toHaveLength(20);
    expect(new Set(AI_PHASE_1_CAPABILITIES.map((c) => c.capabilityKey)).size).toBe(20);
    expect(AI_PHASE_1_INVENTORY_GAPS.map((g) => g.id)).toContain(
      "prediction-capability-count-does-not-reconcile",
    );
  });

  it("marks three APPROVED — the §2.4 table and its closer against its own lead sentence", () => {
    expect([...AI_PHASE_1_APPROVED_CAPABILITY_KEYS].sort()).toEqual([
      "embeddings_clinical",
      "hearthnote_layer2",
      "idg_layer2_polish",
    ]);
  });

  it("puts nothing at MONITORING, DEPRECATED or RETIRED at lock time", () => {
    for (const capability of AI_PHASE_1_CAPABILITIES) {
      expect(["PROPOSED", "DESIGN_REVIEW", "APPROVED"]).toContain(capability.phase1LifecycleState);
    }
  });

  it("points every stated default backend at a backend §2.3 actually registers", () => {
    for (const capability of AI_PHASE_1_CAPABILITIES) {
      if (capability.defaultBackendKey !== null) {
        expect(isAiPhase1BackendKey(capability.defaultBackendKey)).toBe(true);
      }
    }
  });

  it("leaves the tabular-ML capabilities backend-less rather than inventing a key", () => {
    // `adr_documentation_readiness` is also backend-less, but because NO vendor or model has been
    // chosen (decision D1), not because it is tabular ML, so it is not part of the tabular-ML gap.
    const backendless = AI_PHASE_1_CAPABILITIES.filter(
      (c) =>
        c.defaultBackendKey === null &&
        c.capabilityKey !== "adr_documentation_readiness" &&
        !c.capabilityKey.startsWith("messaging_"),
    ).map((c) => c.capabilityKey);
    expect(
      AI_PHASE_1_CAPABILITIES.find((c) => c.capabilityKey === "adr_documentation_readiness")
        ?.defaultBackendKey,
    ).toBeNull();
    expect(backendless.sort()).toEqual([
      "denial_outcome_prediction",
      "falls_risk_prediction",
      "hospitalization_risk_30d",
      "level_of_care_prediction",
      "mortality_decline_prediction",
    ]);
    const gap = AI_PHASE_1_INVENTORY_GAPS.find((g) => g.id === "tabular-ml-backend-unregistered");
    expect([...(gap?.blocks ?? [])].sort()).toEqual(backendless.sort());
  });

  it("states a risk tier for every capability — an unclassified one is unrepresentable", () => {
    // `riskTier` was `AiCapabilityRiskTier | null` while `level_of_care_prediction` had no stated
    // tier. The architecture catalog now states one for all eighteen, so the type dropped `| null`
    // and this asserts the value side of that: every row carries a real tier. If a future capability
    // arrives unclassified, the fix is a catalog entry, not re-widening the type.
    for (const c of AI_PHASE_1_CAPABILITIES) {
      expect(["high", "medium", "low"]).toContain(c.riskTier);
    }
    expect(AI_PHASE_1_CAPABILITIES_BY_KEY.get("level_of_care_prediction")?.riskTier).toBe("high");
    expect(AI_PHASE_1_INVENTORY_GAPS.map((g) => g.id)).not.toContain(
      "level-of-care-risk-tier-unstated",
    );
  });

  it("resolves the architecture-catalog id where one exists and admits where it does not", () => {
    expect(AI_PHASE_1_CAPABILITIES_BY_KEY.get("hearthnote_layer2")?.governanceCatalogId).toBe(
      "hearthnote-layer-2",
    );
    expect(AI_PHASE_1_CAPABILITIES_BY_KEY.get("idg_layer2_polish")?.governanceCatalogId).toBe(
      "hearthnote-idg-aggregation-layer-2",
    );
    expect(
      AI_PHASE_1_CAPABILITIES_BY_KEY.get("mortality_decline_prediction")?.governanceCatalogId,
    ).toBe("mortality-decline-prediction");
    // Every registered capability now resolves to a catalog id — the six that did not were added to
    // docs/ai/capability-catalog.yaml and to AI Governance §4.1, and check-ai-governance.ts enforces
    // all eighteen. A capability registered here with no governance doc is the hole this closes.
    const uncatalogued = AI_PHASE_1_CAPABILITIES.filter((c) => c.governanceCatalogId === null).map(
      (c) => c.capabilityKey,
    );
    expect(uncatalogued).toEqual([]);
    expect(new Set(AI_PHASE_1_CAPABILITIES.map((c) => c.governanceCatalogId)).size).toBe(
      AI_PHASE_1_CAPABILITIES.length,
    );
    // The gap stays: it now records only the REVERSE direction — `aggregate-cap-projection` is
    // cataloged but has no §2.4 row, so it is registrable by nobody and servable by nothing.
    expect(AI_PHASE_1_INVENTORY_GAPS.map((g) => g.id)).toContain(
      "registry-and-architecture-catalog-are-not-one-to-one",
    );
  });

  it("names the consumer modules as `mN` ids the manifest would recognise", () => {
    for (const capability of AI_PHASE_1_CAPABILITIES) {
      for (const consumer of capability.consumerModules) {
        expect(consumer).toMatch(/^m\d{1,2}$/);
      }
    }
    expect(AI_PHASE_1_CAPABILITIES_BY_KEY.get("hearthnote_layer2")?.consumerModules).toEqual([
      "m8",
      "m14",
      "m16",
    ]);
  });

  it("fails closed on an unregistered capability key", () => {
    expect(isAiPhase1CapabilityKey("hearthnote_layer2")).toBe(true);
    expect(isAiPhase1CapabilityKey("hearthnote_layer_2")).toBe(false);
  });
});

describe("risk-tier-derived governance defaults (§3.2.1)", () => {
  it("requires tenant opt-in at every tier — the column default is true and no tier turns it off", () => {
    // `ai_capability.risk_tier` is NOT NULL, so `null` was never a tier the function can be asked about.
    for (const tier of ["high", "medium", "low"] as const) {
      expect(aiCapabilityGovernanceDefaults(tier).tenantOptInRequired).toBe(true);
    }
  });

  it("requires clinical review for high-risk only", () => {
    expect(aiCapabilityGovernanceDefaults("high").clinicalReviewRequired).toBe(true);
    expect(aiCapabilityGovernanceDefaults("medium").clinicalReviewRequired).toBe(false);
    expect(aiCapabilityGovernanceDefaults("low").clinicalReviewRequired).toBe(false);
  });

  it("requires clinical review for high risk, and cannot be asked about an unstated tier", () => {
    expect(aiCapabilityGovernanceDefaults("high").clinicalReviewRequired).toBe(true);
    // There is deliberately no `null` case left to test. This helper used to resolve an unstated
    // tier to the safe side (review required); now `AiCapabilityRiskTier` admits no null, so the
    // question cannot be asked. `@ts-expect-error` is the assertion — if someone re-widens the
    // parameter this line stops erroring and the test fails, which is the point.
    // @ts-expect-error an unstated risk tier is unrepresentable
    expect(() => aiCapabilityGovernanceDefaults(null)).toBeDefined();
  });
});

describe("the gap list", () => {
  it("carries six gaps with unique ids and non-empty detail", () => {
    // Five until `approved-llm-capability-awaiting-prompt-template` was added: the seed-path work
    // (TASK-062) needed to know, generically, which capabilities the sync script must skip rather than
    // INSERT-and-crash on the `ai_capability_approved_has_template` CHECK, and hearthnote_layer2 /
    // idg_layer2_polish are APPROVED with no real template row anywhere in the repo (T56 not landed).
    // The count is asserted so a gap cannot be silently dropped OR silently added.
    expect(AI_PHASE_1_INVENTORY_GAPS).toHaveLength(6);
    expect(new Set(AI_PHASE_1_INVENTORY_GAPS.map((g) => g.id)).size).toBe(6);
    for (const gap of AI_PHASE_1_INVENTORY_GAPS) {
      expect(gap.detail.length).toBeGreaterThan(80);
    }
  });

  it("flags the APPROVED LLM capabilities still waiting on a real T56 prompt template", () => {
    const gap = AI_PHASE_1_INVENTORY_GAPS.find(
      (g) => g.id === "approved-llm-capability-awaiting-prompt-template",
    );
    expect(gap?.blocks).toEqual(["hearthnote_layer2", "idg_layer2_polish"]);
    // Distinct from embeddings_clinical's gap: both of these ARE LLM-backed and APPROVED, so they are
    // seedable in principle — just not until a real ai_prompt_template row exists to point at.
    for (const key of gap?.blocks ?? []) {
      expect(AI_PHASE_1_APPROVED_CAPABILITY_KEYS).toContain(key);
    }
  });

  it("blocks only capabilities the inventory actually registers", () => {
    for (const gap of AI_PHASE_1_INVENTORY_GAPS) {
      for (const key of gap.blocks) {
        expect(isAiPhase1CapabilityKey(key)).toBe(true);
      }
    }
  });

  it("flags the APPROVED non-LLM capability the §3.2.1 CHECK makes unseedable", () => {
    const gap = AI_PHASE_1_INVENTORY_GAPS.find(
      (g) => g.id === "approved-non-llm-capability-needs-template",
    );
    expect(gap?.blocks).toEqual(["embeddings_clinical"]);
    // The contradiction is real only because the row is APPROVED — if T02 demotes it, re-read the gap.
    expect(AI_PHASE_1_APPROVED_CAPABILITY_KEYS).toContain("embeddings_clinical");
  });
});

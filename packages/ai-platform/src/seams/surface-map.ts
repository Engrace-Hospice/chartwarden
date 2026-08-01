// @wardenx/ai-platform — the seam-surface → `ai_capability.capability_key` map (M32-T06).
//
// M32 owns this mapping so that no consumer can name a capability row directly. A seam takes a SURFACE
// (`encounter_note`, `clinical`, `signature_presence`) and M32 decides which registered capability
// serves it. Two things follow, and both are the point:
//
//   · the reachable capability set is CLOSED — a consumer cannot probe the registry by guessing keys;
//   · a capability key can be renamed, split or re-pointed without touching M8 / M14 / M16 / M22 / M25.
//
// ── THE MAP IS PARTIAL, AND SAYING SO IS THE HONEST PART ──────────────────────────────────────────
//
// `discipline_plan_goal_rationale` (§4.2.1's fifth narrative surface, M15's) resolves to NOTHING: §2.4's
// Phase-1 inventory registers no capability for it, and the architecture capability catalog names none
// either. The alternatives were both worse than a `null`:
//
//   · inventing a key (`discipline_plan_rationale`) would create a permanently dead registry row that
//     every `findByKey` misses — the exact `level-of-care-prediction` failure §2.4 already records;
//   · routing it to `hearthnote_layer2` would let an M15 goal rationale run under the governance,
//     calibration and kill switch of the ENCOUNTER-note capability, so a SEV-1 kill on encounter notes
//     would silently also stop (or, worse, not stop) a different clinical surface.
//
// A `null` refuses at the seam, names the surface in `detail`, and stays a one-line change the day
// somebody registers the capability.
import type { CopilotScope } from "./copilot";
import type { NarrativeSurface } from "./narrative-enhancement";

/** §4.2.1's five surfaces → the §2.4 capability that serves each. `null` = no capability is registered. */
export const AI_NARRATIVE_SURFACE_CAPABILITY: Readonly<Record<NarrativeSurface, string | null>> = {
  encounter_note: "hearthnote_layer2",
  // Both IDG surfaces route to the SAME capability. §2.4 registers `idg_layer2_polish` as a distinct
  // capability from `hearthnote_layer2` precisely so a tenant can opt out per-meeting; it does not
  // split the packet cover from the per-discipline summary, and inventing that split here would put a
  // second unregistered key in the map.
  idg_summary: "idg_layer2_polish",
  idg_discipline_summary: "idg_layer2_polish",
  bereavement_risk_narrative: "bereavement_risk_narrative",
  discipline_plan_goal_rationale: null,
};

/** §4.2.2's four DocLens seams → their §2.4 capabilities. Total: all four are registered. */
export const AI_DOCLENS_CAPABILITY = {
  classify: "doclens_classify",
  extract: "doclens_extract",
  visionVerify: "doclens_vision_verify",
  sudDetect: "doclens_sud_detect",
} as const;

/** §4.2.6's copilot scopes → the two §2.4 copilot capabilities. */
export const AI_COPILOT_SCOPE_CAPABILITY: Readonly<Record<CopilotScope, string>> = {
  clinical: "copilot_clinical",
  administrative: "copilot_admin",
};

/** The remaining one-surface seams (§4.2.3–§4.2.6), by seam name. */
export const AI_SEAM_CAPABILITY = {
  ProtocolSuggestionProvider: "protocol_suggestion_oncall",
  HospitalizationRiskProvider: "hospitalization_risk_30d",
  BereavementRiskNarrativeProvider: "bereavement_risk_narrative",
  DenialOutcomePredictionProvider: "denial_outcome_prediction",
  EmbeddingsProvider: "embeddings_clinical",
  SemanticSearchProvider: "semantic_search_chart",
} as const;

/** Resolve a narrative surface. `null` means no capability is registered for it — refuse, never guess. */
export function aiCapabilityKeyForNarrativeSurface(surface: NarrativeSurface): string | null {
  return AI_NARRATIVE_SURFACE_CAPABILITY[surface] ?? null;
}

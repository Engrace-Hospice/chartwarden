// @wardenx/ai-platform — §4.2.1 `NarrativeEnhancementProvider` (M32-T06).
//
// The hot Phase-1 seam. M8 (HearthNote Layer 2) is the locked consumer and the reason M32 exists at all;
// M14 (IDG cover polish) and M16 (bereavement risk narrative) attach optionally.
//
// ── ONE SEAM, FIVE SURFACES, AND THE SURFACE IS NOT THE CAPABILITY ──────────────────────────────
//
// §4.2.1 keys the call on a `surface`, not a capability key, and that indirection is load-bearing: a
// consumer must not be able to name an arbitrary `ai_capability` row. M32 owns the surface → capability
// mapping (`./surface-map`), so the set of capabilities a narrative caller can reach is closed, and a
// capability's key can change without touching M8.
//
// The mapping is deliberately NOT total. §2.4's Phase-1 inventory registers no capability for
// `discipline_plan_goal_rationale` (M15's surface), so that surface resolves to nothing and the seam
// refuses. Inventing a key would have produced a permanently dead registry row every `findByKey` misses.
import type { AIWarning, AiSeamRefusal } from "./common";

/**
 * The narrative surfaces §4.2.1 names. Each is a PLACE in the product, and M32 maps it to whichever
 * capability serves it (see `./surface-map`).
 */
export type NarrativeSurface =
  | "encounter_note"
  | "idg_summary"
  | "idg_discipline_summary"
  | "bereavement_risk_narrative"
  | "discipline_plan_goal_rationale";

/** The parent aggregates a narrative enhancement can hang off — `ai_invocation.consumer_context_ref`. */
export type NarrativeParentEntityType =
  | "encounter"
  | "idg_session"
  | "bereavement_event"
  | "discipline_care_plan";

/** §4.2.1's input. `chartContext` is bounded by the capability's §8.3 ruleset, enforced at this boundary. */
export interface NarrativeEnhancementInput {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly surface: NarrativeSurface;
  readonly draftText: string;
  /** Shape per capability schema; validated by the §8.3 PHI-minimisation gate inside the SDK. */
  readonly chartContext: Record<string, unknown>;
  readonly parentEntityType: NarrativeParentEntityType;
  readonly parentEntityId: string;
  /** Omit for a non-patient-scoped surface. Its presence is §3.2.8's PHI indicator. */
  readonly patientId?: string | null;
}

/** The available arm of §4.2.1's result. */
export interface NarrativeEnhancementAvailable {
  readonly available: true;
  /** FK to `ai_invocation`; the caller stores it and later reports the HITL outcome against it. */
  readonly invocationId: string;
  readonly enhanced: {
    readonly text: string;
    /** [0, 1]. */
    readonly confidence: number;
    readonly warnings: readonly AIWarning[];
    /** The pin the BACKEND echoed, for audit — not the one the registry expected. */
    readonly modelVersionPin: string;
  };
}

export type NarrativeEnhancementResult = NarrativeEnhancementAvailable | AiSeamRefusal;

/**
 * §4.2.1 — enhance a clinician-authored draft with the capability registered for `surface`.
 *
 * NEVER THROWS to indicate AI absence. Callers MUST branch on `available` and fall back to their own
 * Layer-1 text; the whole design of M8's finalize path assumes this call can decline.
 */
export interface NarrativeEnhancementProvider {
  enhance(input: NarrativeEnhancementInput): Promise<NarrativeEnhancementResult>;
}

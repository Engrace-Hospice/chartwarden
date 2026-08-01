// @wardenx/ai-platform — §4.2.4 `BereavementRiskNarrativeProvider` (M32-T06).
//
// Consumed by M16, optionally: M16 ships the deterministic D3/D17 complicated-grief score alone and
// AUGMENTS it with a narrative when this seam is available. The deterministic `rule_tier` is what a
// cadence decision is made on (AI Governance §7.4) — this seam never moves it, it only narrates it.
//
// `riskFactors` arrives from M16's own `BereavementRiskFactorsProvider`, so M32 does not traverse M16's
// chart: the consumer supplies the bounded snapshot, per D5.
import type { AIWarning, AiSeamRefusal } from "./common";

/** §4.2.4's input. The survivor roles carry RELATIONSHIPS, never the bereaved contact's channels —
 *  M16's `email` / `phone` / `address` ciphers are §3.3.2-denylisted and never cross a seam. */
export interface BereavementRiskNarrativeInput {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly bereavementEventId: string;
  /** §4.2.4 spells this `surviorRoleSnapshot`; the typo is not reproduced (nothing consumes it yet). */
  readonly survivorRoleSnapshot: readonly {
    readonly role: string;
    readonly relationship: string;
  }[];
  /** From M16's `BereavementRiskFactorsProvider`. */
  readonly riskFactors: readonly {
    readonly key: string;
    readonly value: unknown;
    readonly severity: "low" | "medium" | "high";
  }[];
}

export type BereavementNarrativeResult =
  | {
      readonly available: true;
      readonly invocationId: string;
      readonly narrative: string;
      readonly confidence: number;
      readonly warnings: readonly AIWarning[];
    }
  | AiSeamRefusal;

/** §4.2.4 — compose a narrative summary of complicated-grief risk factors for the coordinator. */
export interface BereavementRiskNarrativeProvider {
  composeNarrative(input: BereavementRiskNarrativeInput): Promise<BereavementNarrativeResult>;
}

// apps/backend/src/modules/05-patient/wristband-plan.ts -- GAP-020: the PURE decisions behind issuing and voiding
// a patient wristband generation. The routes run them inside one tenant transaction that has the patient row
// `FOR UPDATE`, so the generations they are shown cannot change under them.
import type { WristbandIssueReason } from "@wardenx/types";

/** The slice of one `patient_wristband` row the planners need. */
export interface WristbandGenerationState {
  readonly generation: number;
  readonly supersededAt: Date | null;
  readonly voidedAt: Date | null;
}

export type WristbandIssuePlan =
  | {
      readonly ok: true;
      readonly nextGeneration: number;
      /** The currently ACTIVE generation to supersede in the same transaction, or null if none is active. */
      readonly supersedeGeneration: number | null;
    }
  | {
      readonly ok: false;
      readonly code: "WRISTBAND_GENERATION_CONFLICT";
      readonly currentGeneration: number | null;
    }
  | { readonly ok: false; readonly code: "WRISTBAND_REASON_INVALID" };

const isActive = (g: WristbandGenerationState): boolean =>
  g.supersededAt === null && g.voidedAt === null;

/**
 * Plan a print. `expectedCurrentGeneration` is the generation the caller saw as active (null = none): if the
 * server's active generation differs, somebody else printed first (double-click, two nurses) and this print is
 * refused rather than minting a second live band. Numbers continue after the highest ever issued, voided ones
 * included, so a generation number is never reused.
 */
export function planWristbandIssue(args: {
  readonly generations: readonly WristbandGenerationState[];
  readonly expectedCurrentGeneration: number | null;
  readonly reason: WristbandIssueReason;
}): WristbandIssuePlan {
  const active = args.generations.find(isActive) ?? null;
  const currentGeneration = active?.generation ?? null;
  if (currentGeneration !== args.expectedCurrentGeneration)
    return { ok: false, code: "WRISTBAND_GENERATION_CONFLICT", currentGeneration };

  const everIssued = args.generations.length > 0;
  if ((args.reason === "first_issue") === everIssued)
    return { ok: false, code: "WRISTBAND_REASON_INVALID" };

  const highest = args.generations.reduce((max, g) => Math.max(max, g.generation), 0);
  return { ok: true, nextGeneration: highest + 1, supersedeGeneration: currentGeneration };
}

export type WristbandVoidPlan =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "NOT_FOUND" | "WRISTBAND_ALREADY_VOIDED" };

/** Plan a void of one named generation (active or superseded; a voided one is already dead). */
export function planWristbandVoid(args: {
  readonly generations: readonly WristbandGenerationState[];
  readonly generation: number;
}): WristbandVoidPlan {
  const target = args.generations.find((g) => g.generation === args.generation);
  if (!target) return { ok: false, code: "NOT_FOUND" };
  if (target.voidedAt !== null) return { ok: false, code: "WRISTBAND_ALREADY_VOIDED" };
  return { ok: true };
}

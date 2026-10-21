// @chartwarden/ai-platform — §4.2.6 `CopilotProvider` (M32-T06).
//
// Two §2.4 capabilities sit behind this one seam — `copilot_clinical` (high risk) and `copilot_admin`
// (medium) — and the caller picks between them with `scope`, not with a capability key. Same reason as
// §4.2.1's `surface`: the set of capabilities a consumer can reach stays closed and M32 owns the
// mapping (`./surface-map`).
//
// THE ANSWER CARRIES ITS CITATIONS OR IT IS NOT AN ANSWER. §2.4's note on `copilot_clinical` is the
// sharpest constraint on this file: it is a DIRECT UI surface with no consumer module, so "there is no
// upstream module enforcing chart scope for it" — the M3 `caseload_or_scope` predicate is the only
// thing between a question and another clinician's patient. `citations` therefore returns entity
// references the caller re-reads through the owning module's authorized read path; a copilot answer that
// asserted facts with nothing to check them against would make that predicate unverifiable at the point
// it matters.
import type { AIWarning, AiSeamRefusal } from "./common";

/** Which copilot answers: the clinical Q&A capability, or the administrative one. */
export type CopilotScope = "clinical" | "administrative";

export interface CopilotAskInput {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly scope: CopilotScope;
  readonly question: string;
  /** Required for `scope: 'clinical'` — the chart the question is asked ABOUT, which is what the M3
   *  `caseload_or_scope` predicate is evaluated against. */
  readonly patientId?: string | null;
  /** Bounded per the capability's §8.3 ruleset, enforced at this boundary. */
  readonly chartContext: Record<string, unknown>;
}

/** A reference the caller re-reads through the owning module's own authorized read path. */
export interface CopilotCitation {
  readonly sourceEntityType: string;
  readonly sourceEntityId: string;
  /** Free-text locator within the source (a section heading, a field name). Never PHI content. */
  readonly locator?: string;
}

export type CopilotAskResult =
  | {
      readonly available: true;
      readonly invocationId: string;
      readonly answer: string;
      readonly confidence: number;
      readonly citations: readonly CopilotCitation[];
      readonly warnings: readonly AIWarning[];
      readonly modelVersionPin: string;
    }
  | AiSeamRefusal;

/** §4.2.6 — chart copilot Q&A. */
export interface CopilotProvider {
  ask(input: CopilotAskInput): Promise<CopilotAskResult>;
}

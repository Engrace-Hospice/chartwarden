// apps/backend/src/modules/07-care-plan/lifecycle/validation.ts — M7-T03 (§2.3 validation rules).
//
// The synchronous §2.3 validation catalog as pure guards over already-resolved facts (the M38 ICD-10
// check and the M39 DPOA-consent state are resolved by the caller and passed in — no cross-module
// import edge). Each guard raises the precise §2.3 machine-readable code via `CarePlanStateError`. The
// version/element machines call these at the relevant transition; the service layer (M7-T05) reuses
// them for field-level request validation. The async rules (5-day / 15-day clocks, ICD-10 currency)
// are NOT here — they are workers/seam reads wired in M7-T07.
import type { GoalSource } from "@chartwarden/types";
import { require_ } from "./errors";

/** Free-text minimum lengths the §2.3 sync rules enforce (machine form trimmed). */
export const TEXT_MINIMUMS = {
  /** A resolved problem must carry a resolution note (§2.2.3). */
  resolutionNote: 1,
  /** A discontinued intervention must carry a reason (§2.2.3). */
  discontinueReason: 1,
} as const;

/** §2.3 — the initial version must include ≥1 problem at the `draft → in_review` transition (CoP 418.56(c)). */
export function checkInitialHasProblem(activeProblemCount: number): void {
  require_(
    activeProblemCount >= 1,
    "INITIAL_VERSION_REQUIRES_PROBLEM",
    "the initial care-plan version must include at least one problem (CoP 418.56(c))",
  );
}

/** §2.3 — ≥1 terminal active problem is required to sign the initial version (warned, not blocked, on idg_review). */
export function checkTerminalProblemPresent(hasTerminalActiveProblem: boolean): void {
  require_(
    hasTerminalActiveProblem,
    "TERMINAL_PROBLEM_REQUIRED",
    "the initial care-plan version requires at least one active terminal problem to sign",
  );
}

/** §2.3 — a goal must reference a problem (`goal.problem_id NOT NULL`; FK + service-level). */
export function checkGoalReferencesProblem(problemId: string | null | undefined): void {
  require_(
    typeof problemId === "string" && problemId.length > 0,
    "GOAL_REQUIRES_PROBLEM",
    "a goal must reference a problem",
  );
}

/** §2.3 — an intervention must reference a problem (`intervention.problem_id NOT NULL`). */
export function checkInterventionReferencesProblem(problemId: string | null | undefined): void {
  require_(
    typeof problemId === "string" && problemId.length > 0,
    "INTERVENTION_REQUIRES_PROBLEM",
    "an intervention must reference a problem",
  );
}

/** §2.3 — an intervention must carry a frequency (`frequency_value NOT NULL`). */
export function checkInterventionFrequency(frequencyValue: string | null | undefined): void {
  require_(
    typeof frequencyValue === "string" && frequencyValue.trim().length > 0,
    "INTERVENTION_FREQUENCY_REQUIRED",
    "an intervention must specify a frequency",
  );
}

/** Goal sources whose `original_text` is preserved verbatim (D6 — never mutated after first write). */
const VERBATIM_GOAL_SOURCES: ReadonlySet<GoalSource> = new Set<GoalSource>([
  "patient_stated",
  "family_stated",
  "agent_stated",
]);

/** Whether a goal source preserves its stated text verbatim (patient/family/agent-stated). */
export function isVerbatimGoalSource(source: GoalSource): boolean {
  return VERBATIM_GOAL_SOURCES.has(source);
}

/**
 * §2.3 — patient/family/agent-stated goals capture `original_text` verbatim: it is required on create
 * and immutable on update. `mutatingOriginalText=true` on an update of a verbatim-source goal is refused
 * (the DB trigger is the defense-in-depth backstop; this is the service-level guard).
 */
export function checkPatientStatedGoalVerbatim(args: {
  readonly source: GoalSource;
  readonly originalText: string | null | undefined;
  readonly isUpdate: boolean;
  readonly mutatingOriginalText: boolean;
}): void {
  if (!isVerbatimGoalSource(args.source)) return;
  if (args.isUpdate) {
    require_(
      !args.mutatingOriginalText,
      "PATIENT_STATED_GOAL_VERBATIM",
      "a patient/family/agent-stated goal's original_text is immutable",
    );
    return;
  }
  require_(
    typeof args.originalText === "string" && args.originalText.trim().length > 0,
    "PATIENT_STATED_GOAL_VERBATIM",
    "a patient/family/agent-stated goal must capture original_text verbatim",
  );
}

/**
 * §2.3 — a DPOA agent-authored goal requires an active `dpoa_healthcare` consent for the patient at
 * write time. `agentConsentActive` is the M39 consent state resolved by the caller (no import edge).
 */
export function checkDpoaGoalConsent(source: GoalSource, agentConsentActive: boolean): void {
  if (source !== "agent_stated") return;
  require_(
    agentConsentActive,
    "DPOA_CONSENT_REQUIRED",
    "an agent-stated goal requires an active dpoa_healthcare consent for the patient",
  );
}

/**
 * §2.3 / §7.7 — optimistic concurrency: a PATCH carries the row `version` it read (`If-Match` / ETag);
 * a mismatch against the current row version is a stale write and is refused with 412.
 */
export function checkOptimisticConcurrency(expectedVersion: number, currentVersion: number): void {
  require_(
    expectedVersion === currentVersion,
    "STALE_VERSION",
    `stale write: expected row version ${expectedVersion} but current is ${currentVersion}`,
  );
}

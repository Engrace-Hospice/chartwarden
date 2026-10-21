import {
  CORRECTIVE_ACTIONS_MIN_LENGTH,
  PLAN_KIND_AUTHOR_DISCIPLINES,
  VOLUNTEER_OUT_OF_SCOPE,
  type VolunteerOutOfScopeItem,
} from "@chartwarden/discipline-plans";
// apps/backend/src/modules/15-discipline-care-plans/lifecycle/validation.ts — M15-T03 (§2.3).
//
// The synchronous §2.3 validation catalog as pure guards over already-resolved facts. Every cross-module
// fact (the M6 admission state, the M7 parent problem/goal, the M8 signed encounter, the M39 DPOA consent)
// is resolved by the caller through the owning module's seam and passed in as a plain boolean/value — no
// cross-module import edge, no IO here. Each guard raises the precise §2.3 / §4.2 machine-readable code
// via `DisciplinePlanStateError`. The async rules (the 5-day MSW / chaplain clocks, the 14-day supervisory
// cadence) live in `./initial-clock` and `./supervisory`, which own the day math.
import type {
  DisciplineAuthorRole,
  DisciplineGoalSource,
  DisciplinePlanKind,
} from "@chartwarden/types";
import { require_ } from "./errors";

/** Free-text minimum lengths the §2.3 sync rules enforce (trimmed). */
export const TEXT_MINIMUMS = {
  /** §2.2.3 — a discontinued intervention must carry a reason. */
  discontinueReason: 1,
  /** §2.2.3 — an amended assessment must carry an amendment reason (correction-of-record, M9 D9). */
  amendmentReason: 1,
  /** §2.2.4 / §4.2 — `corrective_actions` when the aide's performance is recorded unsatisfactory. */
  correctiveActions: CORRECTIVE_ACTIONS_MIN_LENGTH,
} as const;

/** Goal sources whose `original_text` is captured verbatim and never mutated after first write (§2.3 / M7 D6). */
const VERBATIM_GOAL_SOURCES: ReadonlySet<DisciplineGoalSource> = new Set<DisciplineGoalSource>([
  "patient_stated",
  "family_stated",
  "agent_stated",
]);

/** Whether a goal source preserves its stated text verbatim (patient/family/agent-stated). */
export function isVerbatimGoalSource(source: DisciplineGoalSource): boolean {
  return VERBATIM_GOAL_SOURCES.has(source);
}

/**
 * §2.3 — a patient/family/agent-stated discipline goal captures `original_text` verbatim: required on
 * create, immutable on update (the M4 audit trigger is the defense-in-depth backstop; this is the
 * service-level guard). The revision goes to `revised_text`, never over the stated words.
 */
export function checkGoalTextVerbatim(args: {
  readonly source: DisciplineGoalSource;
  readonly originalText: string | null | undefined;
  readonly isUpdate: boolean;
  readonly mutatingOriginalText: boolean;
}): void {
  if (!isVerbatimGoalSource(args.source)) return;
  if (args.isUpdate) {
    require_(
      !args.mutatingOriginalText,
      "GOAL_TEXT_IMMUTABLE",
      "a patient/family/agent-stated goal's original_text is immutable",
    );
    return;
  }
  require_(
    typeof args.originalText === "string" && args.originalText.trim().length > 0,
    "GOAL_TEXT_IMMUTABLE",
    "a patient/family/agent-stated goal must capture original_text verbatim",
  );
}

/**
 * §2.3 — an `agent_stated` goal requires an active M39 `dpoa_healthcare` consent for the patient at write
 * time. `dpoaConsentActive` is the ConsentEvaluator verdict resolved by the caller (no import edge).
 */
export function checkDpoaGoalConsent(
  source: DisciplineGoalSource,
  dpoaConsentActive: boolean,
  actingConsentId: string | null | undefined,
): void {
  if (source !== "agent_stated") return;
  require_(
    dpoaConsentActive && typeof actingConsentId === "string" && actingConsentId.length > 0,
    "DPOA_CONSENT_REQUIRED",
    "an agent-stated goal requires an active dpoa_healthcare consent naming the acting agent",
  );
}

/**
 * §2.1 / §2.3 — a discipline goal hangs off an M7 IPOC problem: the parent problem id is required and must
 * have resolved through the `CarePlanReader` seam (`parentExists`, resolved by `../consumers`). A
 * discipline plan that invented its own problems would fork the IPOC the IDG signs (§1.2).
 */
export function checkParentProblem(
  parentProblemId: string | null | undefined,
  parentExists: boolean,
): void {
  require_(
    typeof parentProblemId === "string" && parentProblemId.length > 0,
    "PARENT_PROBLEM_REQUIRED",
    "a discipline goal must reference its parent IPOC problem (M7)",
  );
  require_(
    parentExists,
    "PARENT_ELEMENT_NOT_FOUND",
    "the referenced IPOC problem is not an active problem on this patient's care plan",
  );
}

/**
 * §2.1 / §2.3 — the OPTIONAL parent links (a discipline goal's IPOC goal, a discipline intervention's IPOC
 * intervention). Null is legal — a discipline may add its own goal under a shared problem — but a supplied
 * id must resolve through the `CarePlanReader` seam.
 */
export function checkOptionalParentElement(
  parentId: string | null | undefined,
  parentExists: boolean,
): void {
  if (parentId === null || parentId === undefined || parentId === "") return;
  require_(
    parentExists,
    "PARENT_ELEMENT_NOT_FOUND",
    "the referenced IPOC element is not active on this patient's care plan",
  );
}

/**
 * §2.3 / §1.1 D1 — the discipline-boundary rule: an MSW cannot author the Aide POC, a chaplain cannot
 * author the MSW Plan. `PLAN_KIND_AUTHOR_DISCIPLINES` is the closed matrix; the two documented overrides
 * (IDG Coordinator, Clinical Supervisor for an unavailable RN) are ROLE-based and are applied by the
 * caller via `overrideApplied` — with the ≥40-char documented reason the M3 ABAC layer captures (§6).
 */
export function checkAuthoringDiscipline(
  kind: DisciplinePlanKind,
  discipline: DisciplineAuthorRole,
  overrideApplied = false,
): void {
  if (overrideApplied) return;
  require_(
    PLAN_KIND_AUTHOR_DISCIPLINES[kind].includes(discipline),
    "DISCIPLINE_SCOPE_VIOLATION",
    `discipline '${discipline}' may not author a '${kind}' discipline plan`,
  );
}

/** §2.3 — an intervention must carry a machine-readable frequency (`frequency_value NOT NULL`). */
export function checkInterventionFrequency(frequencyValue: string | null | undefined): void {
  require_(
    typeof frequencyValue === "string" && frequencyValue.trim().length > 0,
    "INTERVENTION_FREQUENCY_REQUIRED",
    "a discipline intervention must specify a frequency",
  );
}

/**
 * §2.2.1 / §2.3 — nothing is authored on a discharged plan. The audit trigger refuses the UPDATE at the DB;
 * this is the service-level guard that answers with the precise code instead of a PG exception (§7.11).
 */
export function checkPlanWritable(planStatus: string): void {
  require_(
    planStatus !== "discharged",
    "PLAN_DISCHARGED",
    "a discharged discipline plan is read-only",
  );
}

/**
 * §2.3 — a `discipline_care_plan_version.state_snapshot` is sealed at `in_review`. Any later write to the
 * snapshot is refused before it reaches the DB trigger (§8.6 Tampering row).
 */
export function checkSnapshotUnsealed(versionStatus: string): void {
  require_(
    versionStatus === "draft",
    "SNAPSHOT_SEALED",
    "the version state_snapshot is sealed at the in_review transition and cannot be rewritten",
  );
}

/**
 * §7.3 — the spiritual-care declination is immutable once recorded: a later family request opens a NEW
 * engagement (a fresh assessment + a version) rather than erasing the patient's recorded wish.
 */
export function checkDeclinationImmutable(alreadyDeclinedAt: string | null): void {
  require_(
    alreadyDeclinedAt === null,
    "SPIRITUAL_DECLINATION_IMMUTABLE",
    "a recorded spiritual-care declination is immutable; re-engagement is captured as a new assessment",
  );
}

/**
 * §1.1 — the Volunteer Plan's initial version may not be finalized until the CLOSED CoP 418.78 out-of-scope
 * list has been acknowledged in full. A coordinator cannot narrow the list; a surveyor sees a signed
 * acknowledgment rather than agency lore.
 */
export function checkVolunteerOutOfScopeAcknowledged(acknowledged: ReadonlyArray<string>): void {
  const have = new Set(acknowledged);
  const missing = VOLUNTEER_OUT_OF_SCOPE.filter((item: VolunteerOutOfScopeItem) => !have.has(item));
  require_(
    missing.length === 0,
    "VOLUNTEER_OUT_OF_SCOPE_UNACKNOWLEDGED",
    `the volunteer out-of-scope acknowledgment is incomplete: ${missing.join(", ")}`,
  );
}

/**
 * §2.5 / §7.10 — optimistic concurrency: a PATCH carries the row `version` it read (`If-Match`); a mismatch
 * against the current row version is a stale write and is refused with 412 + the current row state.
 */
export function checkOptimisticConcurrency(expectedVersion: number, currentVersion: number): void {
  require_(
    expectedVersion === currentVersion,
    "STALE_VERSION",
    `stale write: expected row version ${expectedVersion} but current is ${currentVersion}`,
  );
}

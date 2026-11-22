// apps/backend/src/modules/15-discipline-care-plans/seams/plan-elements-as-of.ts — the S4 rule with ONE home (ADR-0114, VN-D46, VN-D48,
// VN-D49): what a visit note may be drafted from, out of the SEALED `state_snapshot` of the plan version in effect at the visit time.
// The M15 counterpart of M7's `relevantElementsFromVersion`. Pure data in / data out, except that the per-viewer Part 2 verdict is asked
// through a thunk, and only when the snapshot holds Part 2 content at all.
//
// What crosses, and what never does:
//   • OPEN goals only (`not_started`, `in_progress`, `revised`): a met, not-met or discontinued goal is not part of the plan going
//     forward, and listing it would state an outcome. The goal's status, progress and measurable outcome never cross.
//   • ACTIVE interventions only: the scope and frequency the plan states, never who is responsible or why one was stopped.
//   • A goal's text is the clinician's revision when there is one (`revised: true`: those are no longer the words of whoever stated it),
//     else the original, with its source.
//
// FAIL CLOSED, in the shape of `07-care-plan/seams/relevant-elements.ts`: the snapshot is parsed strictly BEFORE redaction (a mangled
// goal must not become an empty, plausible result) and again after it; a goal whose `sudRelated` is anything but the literal `false` is
// Part 2; and the redaction (`redactDisciplineSnapshot`, the rule every version read in M15 uses) is followed by a second, independent
// filter in the projection, so a viewer without disclosure never receives Part 2 content even if one of the two were bypassed.
import type {
  DisciplineGoalAsOf,
  DisciplineGoalSource,
  DisciplineInterventionAsOf,
  DisciplinePlanElementsAsOf,
} from "@chartwarden/types";
import { redactDisciplineSnapshot } from "../routes/snapshot-redaction";
import type { DisciplinePlanVersionAtRecord } from "./store";

/** The goal statuses that are still the plan going forward. */
const OPEN_GOAL_STATUSES: ReadonlySet<string> = new Set(["not_started", "in_progress", "revised"]);

const GOAL_SOURCES: ReadonlySet<string> = new Set<DisciplineGoalSource>([
  "clinical",
  "patient_stated",
  "family_stated",
  "agent_stated",
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A required non-empty string field, or undefined when absent or of another type. */
const str = (r: Record<string, unknown>, key: string): string | undefined =>
  typeof r[key] === "string" && r[key] !== "" ? (r[key] as string) : undefined;

/** A required string field that may be empty (clinician free text), or undefined when of another type. */
const text = (r: Record<string, unknown>, key: string): string | undefined =>
  typeof r[key] === "string" ? (r[key] as string) : undefined;

interface ParsedGoal {
  readonly goalId: string;
  readonly status: string;
  readonly source: DisciplineGoalSource;
  readonly originalText: string;
  readonly revisedText: string | null;
  /** FAIL CLOSED: true unless the sealed goal says the literal `false`. */
  readonly sudRelated: boolean;
}

interface ParsedIntervention {
  readonly interventionId: string;
  readonly status: string;
  readonly scopeText: string;
  readonly frequencyText: string;
  readonly goalRefs: readonly string[];
}

interface ParsedSnapshot {
  readonly goals: readonly ParsedGoal[];
  readonly interventions: readonly ParsedIntervention[];
}

function parseGoal(raw: unknown): ParsedGoal | null {
  if (!isRecord(raw)) return null;
  const goalId = str(raw, "goalId");
  const status = str(raw, "status");
  const source = str(raw, "source");
  const originalText = text(raw, "originalText");
  const revised = raw.revisedText;
  if (!goalId || !status || originalText === undefined) return null;
  if (source === undefined || !GOAL_SOURCES.has(source)) return null;
  if (revised !== undefined && revised !== null && typeof revised !== "string") return null;
  return {
    goalId,
    status,
    source: source as DisciplineGoalSource,
    originalText,
    revisedText: typeof revised === "string" && revised.trim() !== "" ? revised : null,
    sudRelated: raw.sudRelated !== false,
  };
}

function parseIntervention(raw: unknown): ParsedIntervention | null {
  if (!isRecord(raw)) return null;
  const interventionId = str(raw, "interventionId");
  const status = str(raw, "status");
  const scopeText = text(raw, "scopeText");
  const frequencyText = text(raw, "frequencyText");
  const { goalRefs } = raw;
  if (!interventionId || !status || scopeText === undefined || frequencyText === undefined) {
    return null;
  }
  if (!Array.isArray(goalRefs) || !goalRefs.every((ref) => typeof ref === "string")) return null;
  return { interventionId, status, scopeText, frequencyText, goalRefs: goalRefs as string[] };
}

/** Parse every element of one list; one malformed element makes the whole list (and so the snapshot) null. */
function parseAll<T>(list: unknown, parse: (raw: unknown) => T | null): T[] | null {
  if (!Array.isArray(list)) return null;
  const parsed = list.map(parse);
  return parsed.every((p): p is T => p !== null) ? (parsed as T[]) : null;
}

/** A frozen `state_snapshot` as goals and interventions, or null when it is not of the expected shape. */
function parseSnapshot(snapshot: unknown): ParsedSnapshot | null {
  if (!isRecord(snapshot)) return null;
  const goals = parseAll(snapshot.goals, parseGoal);
  const interventions = parseAll(snapshot.interventions, parseIntervention);
  return goals === null || interventions === null ? null : { goals, interventions };
}

/** Whether an intervention serves a goal in `goalIds` (lower-cased: a uuid is case-insensitive). */
const anchoredTo = (i: ParsedIntervention, goalIds: ReadonlySet<string>): boolean =>
  i.goalRefs.some((ref) => goalIds.has(ref.toLowerCase()));

/**
 * The elements of a frozen plan version for one viewer, or null (fail closed) for a snapshot of an unexpected shape. `sudAllowed` is
 * asked at most once and only when the snapshot holds a goal that is, or may be, Part 2.
 */
export async function planElementsFromVersion(
  version: DisciplinePlanVersionAtRecord,
  sudAllowed: () => Promise<boolean>,
): Promise<DisciplinePlanElementsAsOf | null> {
  // The shape is judged on the RAW snapshot: redaction would otherwise turn a mangled goal into an empty, plausible-looking result.
  const raw = parseSnapshot(version.stateSnapshot);
  if (raw === null) return null;
  const sudGoalIds = new Set(
    raw.goals.filter((g) => g.sudRelated).map((g) => g.goalId.toLowerCase()),
  );
  const allowed = sudGoalIds.size === 0 ? true : await sudAllowed();

  const parsed = parseSnapshot(redactDisciplineSnapshot(version.stateSnapshot, allowed));
  if (parsed === null) return null;

  const goals = parsed.goals
    .filter((g) => OPEN_GOAL_STATUSES.has(g.status) && (allowed || !g.sudRelated))
    .map(
      (g): DisciplineGoalAsOf => ({
        goalId: g.goalId,
        text: g.revisedText ?? g.originalText,
        source: g.source,
        revised: g.revisedText !== null,
        sudRelated: g.sudRelated,
      }),
    )
    // A goal with no words cannot be stated.
    .filter((g) => g.text.trim() !== "");
  const interventions = parsed.interventions
    .filter((i) => i.status === "active" && i.scopeText.trim() !== "")
    .filter((i) => allowed || !anchoredTo(i, sudGoalIds))
    .map(
      (i): DisciplineInterventionAsOf => ({
        interventionId: i.interventionId,
        scopeText: i.scopeText,
        frequencyText: i.frequencyText,
        sudRelated: anchoredTo(i, sudGoalIds),
      }),
    );
  return {
    planId: version.planId,
    patientId: version.patientId,
    goals,
    interventions,
    redacted: !allowed && sudGoalIds.size > 0,
  };
}

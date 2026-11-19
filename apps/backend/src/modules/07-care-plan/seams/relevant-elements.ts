// apps/backend/src/modules/07-care-plan/seams/relevant-elements.ts — the §7.8 encounter-relevance rule with ONE
// home, applied to two sources: today's rows (`relevantElementsForEncounter`) and a frozen version snapshot
// (`relevantElementsAsOf`, VN-D11). Pure data in / data out; the store has already resolved the per-viewer Part 2
// verdict (`sudReadAllowed`), so nothing here touches a tenant or a consent evaluator.
import type {
  GoalId,
  InterventionDiscipline,
  InterventionId,
  ProblemId,
  RelevantCarePlanElements,
  RelevantGoal,
  RelevantIntervention,
} from "@chartwarden/types";
import { redactStateSnapshot } from "../routes/snapshot-redaction";
import type {
  CarePlanElementsRecord,
  CarePlanVersionAtRecord,
  StoredRelevantProblem,
} from "./store";

/**
 * §7.8: active problems (SUD ones only for an entitled viewer, D7), the active interventions tagged with
 * `discipline` on visible problems, and the goals of those interventions' PARENT problems (not every goal).
 */
export function projectRelevantElements(
  record: CarePlanElementsRecord,
  discipline: InterventionDiscipline,
): RelevantCarePlanElements {
  const sudPresent = record.problems.some((p) => p.containsSud);
  const visibleProblems = record.problems.filter(
    (p) => p.status === "active" && (record.sudReadAllowed || !p.containsSud),
  );
  const visibleProblemIds = new Set(visibleProblems.map((p) => p.problemId));
  const interventions = record.interventions.filter(
    (i) =>
      i.status === "active" && i.discipline === discipline && visibleProblemIds.has(i.problemId),
  );
  const parentProblemIds = new Set(interventions.map((i) => i.problemId));
  const goals = record.goals.filter((g) => parentProblemIds.has(g.problemId));
  return {
    planId: record.planId,
    patientId: record.patientId,
    problems: visibleProblems.map(({ containsSud, ...p }) => ({ ...p, sudRelated: containsSud })),
    goals,
    interventions,
    redacted: !record.sudReadAllowed && sudPresent,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A required non-empty string field, or undefined when absent or of another type. */
const str = (r: Record<string, unknown>, key: string): string | undefined =>
  typeof r[key] === "string" && r[key] !== "" ? (r[key] as string) : undefined;

/** A required string field that may be empty (clinician free text), or undefined when of another type. */
const text = (r: Record<string, unknown>, key: string): string | undefined =>
  typeof r[key] === "string" ? (r[key] as string) : undefined;

/** A nullable string field: the string, null when absent or null, undefined when of another type. */
const strOrNull = (r: Record<string, unknown>, key: string): string | null | undefined => {
  const v = r[key];
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : undefined;
};

interface ParsedSnapshot {
  readonly problems: readonly StoredRelevantProblem[];
  readonly goals: readonly RelevantGoal[];
  readonly interventions: readonly RelevantIntervention[];
}

function parseProblem(raw: unknown): StoredRelevantProblem | null {
  if (!isRecord(raw)) return null;
  const id = str(raw, "id");
  const description = text(raw, "description");
  const kind = str(raw, "kind");
  const status = str(raw, "status");
  const icd10Code = strOrNull(raw, "icd10Code");
  const snomedCode = strOrNull(raw, "snomedCode");
  if (!id || description === undefined || !kind || !status) return null;
  if (icd10Code === undefined || snomedCode === undefined) return null;
  return {
    problemId: id as ProblemId,
    icd10Code,
    snomedCode,
    description,
    kind: kind as StoredRelevantProblem["kind"],
    status: status as StoredRelevantProblem["status"],
    // Fail closed, as `redactStateSnapshot` does: anything but the literal `false` is Part 2.
    containsSud: raw.sudRelated !== false,
  };
}

function parseGoal(raw: unknown): RelevantGoal | null {
  if (!isRecord(raw)) return null;
  const id = str(raw, "id");
  const problemId = str(raw, "problemId");
  const source = str(raw, "source");
  const status = str(raw, "status");
  // The goal's CURRENT display text: the revision when there is one, else the verbatim original (as the live read).
  const goalText = str(raw, "revisedText") ?? text(raw, "originalText");
  if (!id || !problemId || !source || !status || goalText === undefined) return null;
  return {
    goalId: id as GoalId,
    problemId: problemId as ProblemId,
    text: goalText,
    source: source as RelevantGoal["source"],
    status: status as RelevantGoal["status"],
  };
}

function parseIntervention(raw: unknown): RelevantIntervention | null {
  if (!isRecord(raw)) return null;
  const id = str(raw, "id");
  const problemId = str(raw, "problemId");
  const discipline = str(raw, "discipline");
  const status = str(raw, "status");
  const scopeText = text(raw, "scopeText");
  const frequencyText = text(raw, "frequencyText");
  if (!id || !problemId || !discipline || !status) return null;
  if (scopeText === undefined || frequencyText === undefined) return null;
  return {
    interventionId: id as InterventionId,
    problemId: problemId as ProblemId,
    scopeText,
    frequencyText,
    discipline: discipline as InterventionDiscipline,
    status: status as RelevantIntervention["status"],
  };
}

/** Parse every element of one list; one malformed element makes the whole list (and so the snapshot) null. */
function parseAll<T>(list: unknown, parse: (raw: unknown) => T | null): T[] | null {
  if (!Array.isArray(list)) return null;
  const parsed = list.map(parse);
  return parsed.every((p): p is T => p !== null) ? (parsed as T[]) : null;
}

/** A frozen `state_snapshot` as picker elements, or null when it is not of the expected shape. */
function parseSnapshot(snapshot: unknown): ParsedSnapshot | null {
  if (!isRecord(snapshot)) return null;
  const problems = parseAll(snapshot.problems, parseProblem);
  const goals = parseAll(snapshot.goals, parseGoal);
  const interventions = parseAll(snapshot.interventions, parseIntervention);
  if (problems === null || goals === null || interventions === null) return null;
  return { problems, goals, interventions };
}

/**
 * VN-D11: the picker elements of a frozen version, for one viewer. The snapshot is redacted FIRST through the
 * ledger's own `redactStateSnapshot` (the rule every version read in M7 uses), then parsed strictly, then run
 * through the shared encounter-relevance rule, which drops SUD content again for a viewer without disclosure:
 * two independent filters, so a viewer without disclosure never receives an unredacted result. `redacted` is
 * true when the redaction withheld anything. Null (fail closed) for a snapshot of an unexpected shape.
 */
export function relevantElementsFromVersion(
  version: CarePlanVersionAtRecord,
  discipline: InterventionDiscipline,
): RelevantCarePlanElements | null {
  // The shape is judged on the RAW snapshot: redaction would otherwise turn a mangled problem into an empty,
  // plausible-looking result instead of the fail-closed null.
  if (parseSnapshot(version.stateSnapshot) === null) return null;
  const safe = redactStateSnapshot(version.stateSnapshot, version.sudReadAllowed);
  const parsed = parseSnapshot(safe);
  if (parsed === null) return null;
  const projected = projectRelevantElements(
    {
      planId: version.planId,
      patientId: version.patientId,
      ...parsed,
      sudReadAllowed: version.sudReadAllowed,
    },
    discipline,
  );
  const withheld = !version.sudReadAllowed && isRecord(safe) && safe.redacted === true;
  return { ...projected, redacted: withheld };
}

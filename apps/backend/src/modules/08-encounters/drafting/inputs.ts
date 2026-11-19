// apps/backend/src/modules/08-encounters/drafting/inputs.ts — the as-of, per-viewer reads behind a visit-note draft
// (S1 PR C2a; VN-D5, VN-D9, VN-D10, VN-D11, design §3.2 "Input rules"). Reads only through `DraftPorts`.
//
// FAIL CLOSED: a read that throws, or returns something that is not usable (an instant that is not one, a care
// plan of another patient), is `DRAFT_UNAVAILABLE` (503). A draft that is missing a source is never returned as if
// it were complete, and nothing is swallowed: the failing read's name goes in the message, the cause stays on
// the error for the server log (the upstream message may carry PHI, so it never reaches the response).
import type {
  CarePlanDraftInput,
  DraftInputs,
  MedicationChangeInput,
  MedicationChangeKind,
  ScaleReadingInput,
  VitalsDraftInput,
} from "@chartwarden/hearthnote";
import { localDateInTimeZone } from "@chartwarden/shared/dates";
import type {
  EncounterDiscipline,
  InterventionDiscipline,
  MedicationOrderChange,
  RelevantCarePlanElements,
  ScaleSeriesPoint,
  ScaleType,
} from "@chartwarden/types";
import { EncounterStateError } from "../lifecycle/errors";
import type { DraftEncounter, DraftPorts, DraftViewer } from "./ports";

/** The sources of a draft: `DraftInputs` minus the selection tree and slots, which `computeDraft` loads. */
export type DraftSourceInputs = Omit<DraftInputs, "selection" | "context">;

/** The only scales with phrases in v1 (`packages/hearthnote/src/draft/sources.ts`). */
const DRAFTED_SCALES: readonly ScaleType[] = ["pps", "esas_r"];
// ponytail: the series is read from the epoch to the visit time and the latest points are picked here; a patient
// with thousands of readings would want an M9 `latestAsOf` read instead.
const SERIES_FROM = "1970-01-01T00:00:00.000Z";
/** The M9 series carries one score per ESAS-r capture: the total, not a symptom, so the phrase names the total. */
const ESAS_TOTAL_LABEL = "total";

const unavailable = (read: string, cause?: unknown): EncounterStateError =>
  new EncounterStateError(
    "DRAFT_UNAVAILABLE",
    `the visit-note draft could not be computed: ${read} is unavailable`,
    undefined,
    cause === undefined ? undefined : { cause },
  );

/** Run one read; any failure, synchronous or not, becomes `DRAFT_UNAVAILABLE` naming the read. */
async function guarded<T>(read: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof EncounterStateError && cause.code === "DRAFT_UNAVAILABLE") throw cause;
    throw unavailable(read, cause);
  }
}

function instantMs(value: unknown, read: string): number {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) throw unavailable(`${read} (an instant that is not one)`);
  return ms;
}

const isoOf = (ms: number): string => new Date(ms).toISOString();

/** The care-plan vocabulary names two disciplines differently from the encounter vocabulary. */
function interventionDisciplineFor(discipline: EncounterDiscipline): InterventionDiscipline {
  switch (discipline) {
    case "md":
    case "np":
      return "md_np";
    case "slp":
      return "st";
    default:
      return discipline;
  }
}

// ── care plan ──────────────────────────────────────────────────────────────────────────────────────
function carePlanInput(
  plan: RelevantCarePlanElements,
  removed: ReadonlySet<string>,
): CarePlanDraftInput {
  // A goal or intervention inherits its parent problem's SUD flag (the reader returns a Part 2 problem only to an
  // entitled viewer). A parent that was not returned proves nothing, so the flag stays undefined and the compiler
  // reads the section as Part 2.
  const sudOf = new Map(plan.problems.map((p) => [p.problemId as string, p.sudRelated]));
  return {
    goals: plan.goals
      .filter((g) => !removed.has(g.goalId))
      .map((g) => ({
        id: g.goalId,
        goalText: g.text,
        progressStatement: null,
        sudRelated: sudOf.get(g.problemId),
      })),
    interventions: plan.interventions
      .filter((i) => !removed.has(i.interventionId))
      .map((i) => ({
        id: i.interventionId,
        interventionText: i.scopeText,
        sudRelated: sudOf.get(i.problemId),
      })),
  };
}

async function readCarePlan(
  ports: DraftPorts,
  encounter: DraftEncounter,
  viewer: DraftViewer,
  asOf: string,
): Promise<CarePlanDraftInput | null> {
  const [plan, removed] = await Promise.all([
    guarded("the care plan", () =>
      ports.carePlanAsOf(
        encounter.patientId,
        encounter.encounterType,
        interventionDisciplineFor(encounter.discipline),
        encounter.admissionId,
        { actor: { roles: viewer.roles, membershipId: viewer.membershipId } },
        asOf,
      ),
    ),
    guarded("the removed care-plan links", () => ports.removedCarePlanElementIds(encounter.id)),
  ]);
  if (plan === null) return null;
  // A plan that is not this patient's must never reach a note, however the seam came to return it.
  if (plan.patientId !== encounter.patientId) throw unavailable("the care plan (wrong patient)");
  return carePlanInput(plan, removed);
}

// ── scale readings ─────────────────────────────────────────────────────────────────────────────────
interface TimedPoint {
  readonly point: ScaleSeriesPoint;
  readonly ms: number;
}

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The latest point captured at or before `limitMs` (ties by assessment id), or `undefined`. */
function latestAtOrBefore(points: readonly TimedPoint[], limitMs: number): TimedPoint | undefined {
  return points.filter((p) => p.ms <= limitMs).at(-1);
}

async function readScale(
  ports: DraftPorts,
  encounter: DraftEncounter,
  scale: ScaleType,
  asOf: string,
  asOfMs: number,
  previousMs: number | null,
  timeZone: string,
): Promise<ScaleReadingInput | null> {
  const series = await guarded(`the ${scale} scale series`, () =>
    ports.scaleSeries(encounter.patientId, scale, SERIES_FROM, asOf),
  );
  const timed = series.points
    .map((point): TimedPoint => ({ point, ms: instantMs(point.capturedAt, `a ${scale} reading`) }))
    .sort((a, b) => a.ms - b.ms || compareIds(a.point.assessmentId, b.point.assessmentId));
  // The latest reading at the visit time. One without a score is not drafted, and an older one does not stand in.
  const latest = latestAtOrBefore(timed, asOfMs);
  if (latest === undefined || latest.point.score === null) return null;
  const before = previousMs === null ? undefined : latestAtOrBefore(timed, previousMs);
  const previous =
    before === undefined || before.point.score === null
      ? null
      : { value: before.point.score, recordedOn: localDateInTimeZone(new Date(before.ms), timeZone) };
  return {
    id: latest.point.assessmentId,
    scaleType: scale,
    ...(scale === "esas_r" ? { label: ESAS_TOTAL_LABEL } : {}),
    value: latest.point.score,
    recordedAt: isoOf(latest.ms),
    previous,
    // M9 redacts only AIMS taken in a SUD context; PPS and ESAS-r are never Part 2 on that seam.
    sudRelated: false,
  };
}

async function readScaleReadings(
  ports: DraftPorts,
  encounter: DraftEncounter,
  asOf: string,
  asOfMs: number,
  previousMs: number | null,
  timeZone: string,
): Promise<readonly ScaleReadingInput[]> {
  const readings = await Promise.all(
    DRAFTED_SCALES.map((scale) =>
      readScale(ports, encounter, scale, asOf, asOfMs, previousMs, timeZone),
    ),
  );
  return readings.filter((r): r is ScaleReadingInput => r !== null);
}

// ── vitals ─────────────────────────────────────────────────────────────────────────────────────────
async function readVitals(
  ports: DraftPorts,
  encounter: DraftEncounter,
  asOf: string,
  asOfMs: number,
): Promise<VitalsDraftInput | null> {
  const vitals = await guarded("the vitals", () => ports.latestVitals(encounter.id, asOf));
  if (vitals === null || instantMs(vitals.recordedAt, "the vitals") > asOfMs) return null;
  // Vital signs carry no Part 2 flag in M8 and are never SUD content: stated here, once, rather than left
  // undefined (which would make every vitals section Part 2 and redact it for a cosigner without disclosure).
  return { ...vitals, sudRelated: false };
}

// ── medication changes ─────────────────────────────────────────────────────────────────────────────
// The corpus has no "completed" phrase; a course that ended is drafted as discontinued on its end date.
const DRAFTED_CHANGE_KIND: Readonly<Record<MedicationOrderChange["kind"], MedicationChangeKind>> = {
  started: "started",
  changed: "changed",
  discontinued: "discontinued",
  completed: "discontinued",
};

async function readMedicationChanges(
  ports: DraftPorts,
  encounter: DraftEncounter,
  viewer: DraftViewer,
  previousIso: string | null,
  asOf: string,
  asOfMs: number,
  timeZone: string,
): Promise<readonly MedicationChangeInput[]> {
  // No previous signed visit means no change window: an honest empty section (VN-D9), not "everything ever".
  if (previousIso === null) return [];
  const all = await guarded("the medication changes", () =>
    ports.medicationChangesBetween(encounter.organizationId, encounter.patientId, previousIso, asOf),
  );
  const changes = all.filter((c) => instantMs(c.at, "a medication change") <= asOfMs);
  // Fail closed: only the literal `false` proves an order is not SUD treatment. The verdict is asked only when
  // there is something it could withhold.
  const mayWithhold = changes.some((c) => c.order.isSudTreatment !== false);
  const disclosed =
    mayWithhold &&
    (await guarded("the Part 2 disclosure verdict", () =>
      ports.part2DisclosureAllowed({
        organizationId: encounter.organizationId,
        patientId: encounter.patientId,
        viewer,
      }),
    ));
  return changes
    .filter((c) => c.order.isSudTreatment === false || disclosed)
    .map((c): MedicationChangeInput => {
      const at = new Date(instantMs(c.at, "a medication change"));
      return {
        // An order can start and stop inside one window; the kind keeps the two sources' ids apart.
        id: `${c.order.id}:${c.kind}`,
        drugName: c.order.drugName,
        change: DRAFTED_CHANGE_KIND[c.kind],
        changedAt: at.toISOString(),
        changedOn: localDateInTimeZone(at, timeZone),
        sudRelated: c.order.isSudTreatment !== false,
      };
    });
}

// ── previous visit ─────────────────────────────────────────────────────────────────────────────────
async function readPreviousVisitMs(
  ports: DraftPorts,
  encounter: DraftEncounter,
  asOfMs: number,
): Promise<number | null> {
  const previous = await guarded("the previous signed visit", () =>
    ports.previousSignedVisitAt(encounter),
  );
  if (previous === null) return null;
  const ms = previous.getTime();
  // "Earlier" is the port's contract; a visit after this one would make a backwards window, so refuse it.
  if (Number.isNaN(ms) || ms > asOfMs) throw unavailable("the previous signed visit (not earlier)");
  return ms;
}

/**
 * Read every source of the draft for `viewer` as of `asOf` (an ISO-8601 instant, from `visitAsOf`).
 * Deterministic: it keeps no state, and equal seam answers give equal inputs.
 */
export async function readDraftInputs(
  ports: DraftPorts,
  encounter: DraftEncounter,
  viewer: DraftViewer,
  asOf: string,
): Promise<DraftSourceInputs> {
  const asOfMs = instantMs(asOf, "the visit time");
  const [timeZone, previousMs] = await Promise.all([
    guarded("the organization time zone", () => ports.organizationTimeZone(encounter.organizationId)),
    readPreviousVisitMs(ports, encounter, asOfMs),
  ]);
  const previousIso = previousMs === null ? null : isoOf(previousMs);
  const [carePlan, scaleReadings, vitals, medicationChanges] = await Promise.all([
    readCarePlan(ports, encounter, viewer, asOf),
    readScaleReadings(ports, encounter, asOf, asOfMs, previousMs, timeZone),
    readVitals(ports, encounter, asOf, asOfMs),
    readMedicationChanges(ports, encounter, viewer, previousIso, asOf, asOfMs, timeZone),
  ]);
  return {
    encounterType: encounter.encounterType,
    discipline: encounter.discipline,
    asOf,
    carePlan,
    scaleReadings,
    vitals,
    medicationChanges,
  };
}

// apps/backend/src/modules/08-encounters/drafting/inputs.ts — the as-of, per-viewer reads behind a visit-note draft
// (S1 PR C2a; VN-D5, VN-D9, VN-D10, VN-D11, design §3.2 "Input rules"). Reads only through `DraftPorts`.
//
// FAIL CLOSED: a read that throws, or returns something that is not usable (an instant that is not one, a care
// plan of another patient), is `DRAFT_UNAVAILABLE` (503). A draft that is missing a source is never returned as if
// it were complete, and nothing is swallowed: the failing read's name goes in the message, the cause stays on
// the error for the server log (the upstream message may carry PHI, so it never reaches the response).
import type {
  BenefitPeriodDraftInput,
  CarePlanDraftInput,
  DraftInputs,
  MedicationChangeInput,
  MedicationChangeKind,
  ScaleReadingInput,
  VitalsDraftInput,
  WeightDraftInput,
} from "@chartwarden/hearthnote";
import { isWeightUnit, readsBenefitPeriod } from "@chartwarden/hearthnote";
import { localDateInTimeZone } from "@chartwarden/shared/dates";
import type {
  ElectionPeriodSummary,
  EncounterDiscipline,
  InterventionDiscipline,
  LevelOfCare,
  MedicationOrderChange,
  RelevantCarePlanElements,
  ScaleSeriesPoint,
  ScaleType,
} from "@chartwarden/types";
import type { DraftEncounter, DraftPorts, DraftViewer } from "./ports";
import { draftUnavailable, guarded } from "./unavailable";

/** The sources of a draft: `DraftInputs` minus the selection tree and slots, which `computeDraft` loads. */
export type DraftSourceInputs = Omit<DraftInputs, "selection" | "context">;

/** The only scales with phrases in v1 (`packages/hearthnote/src/draft/sources.ts`). */
const DRAFTED_SCALES: readonly ScaleType[] = ["pps", "esas_r"];
// ponytail: the series is read from the epoch to the visit time and the latest points are picked here; a patient
// with thousands of readings would want an M9 `latestAsOf` read instead.
const SERIES_FROM = "1970-01-01T00:00:00.000Z";
/** The M9 series carries one score per ESAS-r capture: the total, not a symptom, so the phrase names the total. */
const ESAS_TOTAL_LABEL = "total";

function instantMs(value: unknown, read: string): number {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) throw draftUnavailable(`${read} (an instant that is not one)`);
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

/** The viewer's Part 2 verdict, asked at most once per draft and only by a source that needs it. */
type Part2Verdict = () => Promise<boolean>;

function part2VerdictFor(
  ports: DraftPorts,
  encounter: DraftEncounter,
  viewer: DraftViewer,
): Part2Verdict {
  let asked: Promise<boolean> | undefined;
  return () => {
    asked ??= guarded("the Part 2 disclosure verdict", () =>
      ports.part2DisclosureAllowed({
        organizationId: encounter.organizationId,
        patientId: encounter.patientId,
        viewer,
      }),
    );
    return asked;
  };
}

async function readCarePlan(
  ports: DraftPorts,
  encounter: DraftEncounter,
  viewer: DraftViewer,
  asOf: string,
  part2Verdict: Part2Verdict,
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
  if (plan.patientId !== encounter.patientId)
    throw draftUnavailable("the care plan (wrong patient)");
  // `redacted` says M7 withheld Part 2 content from this viewer. That is right for a viewer without disclosure (a reduced plan is
  // their draft, VN-D11), but M7 resolves it in its own M39 call: a viewer this draft's own verdict clears was handed a reduced plan
  // by an outage or a consent change in between, and a draft short of content they may read is never passed off as complete.
  if (plan.redacted && (await part2Verdict()))
    throw draftUnavailable("the care plan (withheld from a viewer entitled to it)");
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

/**
 * S2, PPS only: the first scored reading on or after the benefit period's start that is earlier than `latest` (its value and org-local
 * date), or `null` when `latest` is itself the first of the period. A reading from an earlier period is never the baseline.
 */
function baselineOf(
  timed: readonly TimedPoint[],
  latest: TimedPoint,
  periodStart: string,
  timeZone: string,
): { readonly value: number; readonly recordedOn: string } | null {
  for (const { point, ms } of timed) {
    if (ms >= latest.ms) break;
    if (point.score === null) continue;
    const recordedOn = localDateInTimeZone(new Date(ms), timeZone);
    if (recordedOn >= periodStart) return { value: point.score, recordedOn };
  }
  return null;
}

/** What every scale read of one draft shares: the ports, the visit and the time cuts. */
interface ScaleReadContext {
  readonly ports: DraftPorts;
  readonly encounter: DraftEncounter;
  readonly asOf: string;
  readonly asOfMs: number;
  readonly previousMs: number | null;
  readonly timeZone: string;
  /** The benefit period's start (a local date) for a visit that has one: only then does a PPS reading carry a baseline. */
  readonly periodStart: string | null;
}

async function readScale(
  context: ScaleReadContext,
  scale: ScaleType,
): Promise<ScaleReadingInput | null> {
  const { ports, encounter, asOf, asOfMs, previousMs, timeZone, periodStart } = context;
  const series = await guarded(`the ${scale} scale series`, () =>
    ports.scaleSeries(encounter.patientId, scale, SERIES_FROM, asOf),
  );
  const timed = series.points
    .map((point): TimedPoint => ({ point, ms: instantMs(point.capturedAt, `a ${scale} reading`) }))
    .sort((a, b) => a.ms - b.ms || compareIds(a.point.assessmentId, b.point.assessmentId));
  // The latest reading at the visit time. One without a score is not drafted, and an older one does not stand in.
  const latest = latestAtOrBefore(timed, asOfMs);
  if (latest === undefined || latest.point.score === null) return null;
  // A reading at or before the previous visit was already in that visit's note: it is not new since then (VN-D6, VN-D9), and
  // as `previous` of itself it would read as "unchanged from itself".
  if (previousMs !== null && latest.ms <= previousMs) return null;
  const before = previousMs === null ? undefined : latestAtOrBefore(timed, previousMs);
  const previous =
    before === undefined || before.point.score === null
      ? null
      : {
          value: before.point.score,
          recordedOn: localDateInTimeZone(new Date(before.ms), timeZone),
        };
  return {
    id: latest.point.assessmentId,
    scaleType: scale,
    ...(scale === "esas_r" ? { label: ESAS_TOTAL_LABEL } : {}),
    value: latest.point.score,
    recordedAt: isoOf(latest.ms),
    previous,
    // S2: only a recertification or face-to-face visit knows its benefit period, so only it carries a baseline.
    ...(scale === "pps" && periodStart !== null
      ? { baseline: baselineOf(timed, latest, periodStart, timeZone) }
      : {}),
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
  periodStart: string | null,
): Promise<readonly ScaleReadingInput[]> {
  const context: ScaleReadContext = {
    ports,
    encounter,
    asOf,
    asOfMs,
    previousMs,
    timeZone,
    periodStart,
  };
  const readings = await Promise.all(DRAFTED_SCALES.map((scale) => readScale(context, scale)));
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
  previousIso: string | null,
  asOf: string,
  asOfMs: number,
  timeZone: string,
  part2Verdict: Part2Verdict,
): Promise<readonly MedicationChangeInput[]> {
  // No previous signed visit means no change window: an honest empty section (VN-D9), not "everything ever".
  if (previousIso === null) return [];
  const all = await guarded("the medication changes", () =>
    ports.medicationChangesBetween(
      encounter.organizationId,
      encounter.patientId,
      previousIso,
      asOf,
    ),
  );
  const changes = all.filter((c) => instantMs(c.at, "a medication change") <= asOfMs);
  // Fail closed: only the literal `false` proves an order is not SUD treatment. The verdict is asked only when
  // there is something it could withhold.
  const mayWithhold = changes.some((c) => c.order.isSudTreatment !== false);
  const disclosed = mayWithhold && (await part2Verdict());
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

// ── benefit period and weight (S2: the recertification and face-to-face visits, design §3.3) ────────
const LEVELS_OF_CARE: readonly LevelOfCare[] = [
  "routine_home_care",
  "continuous_home_care",
  "inpatient_respite_care",
  "general_inpatient_care",
];
const ONE_DAY_MS = 86_400_000;
const STRICT_DECIMAL = /^\d+(\.\d+)?$/;

/** The benefit period on the service date: M6's own rule (`findActivePeriodForPatient`), the highest sequence when two cover it. */
function coveringPeriod(
  periods: readonly ElectionPeriodSummary[],
  on: string,
): ElectionPeriodSummary | null {
  const covering = periods
    .filter((p) => p.startDate <= on && on <= (p.actualEndDate ?? p.endDate))
    .sort((a, b) => b.sequence - a.sequence);
  return covering[0] ?? null;
}

/**
 * The period's facts as of the service DATE (VN-D11): the level of care only when exactly one level counted for that day, the
 * face-to-face only when attested, the certification only when signed. Facts only: no narrative is read (VN-D32). The compiler
 * drops a face-to-face attested, or a certification signed, after the service date. Read one after another: the seam reads take turns
 * per request anyway (`serial-seams.ts`).
 */
async function readBenefitPeriod(
  ports: DraftPorts,
  encounter: DraftEncounter,
  period: ElectionPeriodSummary,
): Promise<BenefitPeriodDraftInput> {
  const periodId = String(period.periodId);
  const days = await guarded("the level of care", () =>
    ports.levelOfCareOn(encounter.admissionId, encounter.serviceDate),
  );
  const counted = LEVELS_OF_CARE.filter((level) => days.daysByLevel[level] > 0);
  const f2f = await guarded("the face-to-face encounter", () => ports.attestedFaceToFace(periodId));
  const cti = await guarded("the certification", () => ports.activeCertification(periodId));
  return {
    id: periodId,
    sequence: period.sequence,
    periodKind: period.periodKind,
    startDate: period.startDate,
    endDate: period.endDate,
    levelOfCare: counted.length === 1 ? (counted[0] ?? null) : null,
    faceToFace:
      f2f === null || f2f.attestedAt === null
        ? null
        : {
            id: String(f2f.faceToFaceEncounterId),
            performerRole: f2f.performerRole,
            performedOn: f2f.encounterDate,
            attestedOn: f2f.attestedAt,
            sudRelated: false,
          },
    certification:
      cti === null || cti.status !== "signed" || cti.hospiceMdSignedAt === null
        ? null
        : { id: String(cti.certificationId), signedOn: cti.hospiceMdSignedAt, sudRelated: false },
    // Period dates, the level of care and the F2F and CTI facts are administrative: never SUD content.
    sudRelated: false,
  };
}

/**
 * The patient's latest weight at or before the visit time, with the benefit period's first beside it. A weight that falls before the period
 * start (org-local) or after the visit is not part of the period. Nothing is drafted at all when ANY weight inside the period cannot be used
 * (not a positive decimal, no `kg`/`lb` unit, an unreadable time) or when the weights are in two units: the sentences say "the only weight
 * recorded" and "the first", and a row skipped in silence would make them false. A row holding no text at all was never captured and is not
 * a reading. Nothing is converted.
 */
async function readWeight(
  ports: DraftPorts,
  encounter: DraftEncounter,
  periodStart: string | null,
  asOf: string,
  asOfMs: number,
  timeZone: string,
): Promise<WeightDraftInput | null> {
  if (periodStart === null) return null;
  // The row timestamp is an instant and the period start a local date: read from the day before and cut by local date below.
  const from = new Date(Date.parse(`${periodStart}T00:00:00.000Z`) - ONE_DAY_MS).toISOString();
  const rows = await guarded("the weights", () => ports.weightReadings(encounter, from, asOf));
  const inPeriod: Array<{ id: string; ms: number; on: string; text: string; unit: "kg" | "lb" }> =
    [];
  for (const row of rows) {
    const text = row.weight.trim();
    // An empty weight is a vitals set that never captured one (the capture logic reads it the same way): it is not a reading to use or to refuse.
    if (text === "") continue;
    const ms = Date.parse(row.recordedAt);
    if (Number.isNaN(ms)) return null;
    if (ms > asOfMs) continue;
    const on = localDateInTimeZone(new Date(ms), timeZone);
    if (on < periodStart) continue;
    const unit = row.unit;
    const usable = STRICT_DECIMAL.test(text) && Number(text) > 0 && isWeightUnit(unit);
    if (!usable) return null;
    inPeriod.push({ id: row.id, ms, on, text, unit });
  }
  inPeriod.sort((a, b) => a.ms - b.ms || compareIds(a.id, b.id));
  const latest = inPeriod.at(-1);
  const first = inPeriod[0];
  if (latest === undefined || first === undefined) return null;
  if (new Set(inPeriod.map((w) => w.unit)).size > 1) return null;
  return {
    id: latest.id,
    recordedAt: isoOf(latest.ms),
    recordedOn: latest.on,
    value: latest.text,
    unit: latest.unit,
    baseline: inPeriod.length > 1 ? { value: first.text, recordedOn: first.on } : null,
    // A weight is a vital sign: never SUD content (as `readVitals` states for the rest of the vitals).
    sudRelated: false,
  };
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
  if (Number.isNaN(ms) || ms > asOfMs)
    throw draftUnavailable("the previous signed visit (not earlier)");
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
    guarded("the organization time zone", () =>
      ports.organizationTimeZone(encounter.organizationId),
    ),
    readPreviousVisitMs(ports, encounter, asOfMs),
  ]);
  const previousIso = previousMs === null ? null : isoOf(previousMs);
  const part2Verdict = part2VerdictFor(ports, encounter, viewer);
  // S2: the recertification and face-to-face visits read the benefit period on the service date first, because its start bounds the PPS
  // baseline and the weights. Any other template reads none of it and returns none of the new fields, exactly as before.
  const recert = encounter.encounterType === "recert_visit";
  const readsPeriod = readsBenefitPeriod(encounter.encounterType);
  const period = readsPeriod ? await readCoveringPeriod(ports, encounter) : null;
  const periodStart = period === null ? null : String(period.startDate);
  const [carePlan, scaleReadings, vitals, medicationChanges, weight, benefitPeriod] =
    await Promise.all([
      readCarePlan(ports, encounter, viewer, asOf, part2Verdict),
      readScaleReadings(ports, encounter, asOf, asOfMs, previousMs, timeZone, periodStart),
      readVitals(ports, encounter, asOf, asOfMs),
      readMedicationChanges(ports, encounter, previousIso, asOf, asOfMs, timeZone, part2Verdict),
      readsPeriod
        ? readWeight(ports, encounter, periodStart, asOf, asOfMs, timeZone)
        : Promise.resolve(null),
      recert && period !== null ? readBenefitPeriod(ports, encounter, period) : null,
    ]);
  return {
    encounterType: encounter.encounterType,
    discipline: encounter.discipline,
    asOf,
    carePlan,
    scaleReadings,
    vitals,
    medicationChanges,
    ...(readsPeriod ? { weight } : {}),
    ...(recert ? { benefitPeriod } : {}),
  };
}

/** The benefit period covering the service date, or `null` when none does. */
async function readCoveringPeriod(
  ports: DraftPorts,
  encounter: DraftEncounter,
): Promise<ElectionPeriodSummary | null> {
  const periods = await guarded("the benefit periods", () =>
    ports.electionPeriods(encounter.admissionId),
  );
  return coveringPeriod(periods, encounter.serviceDate);
}

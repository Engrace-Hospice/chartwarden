// packages/hearthnote/src/draft/sources.ts — which source feeds which section, and the sentence each makes.
//
// SECTION -> SOURCE MAPPING (v1; this table is the one place it is decided):
//
//   section              fed by                                              ordering inside the section
//   chief_concern        nothing: no automatic source in v1, always empty    -
//   vitals_review        the visit's vitals                                  fixed: BP, HR, RR, temp, SpO2, pain
//   assessment           PPS scale readings                                  by source id
//   symptom_management   ESAS-r scale readings                               by label, then source id
//   interventions        care-plan interventions, then medication changes    by source id; changes by time, then id
//   plan                 care-plan goals (with progress when one is stated)  by source id
//
// Sources are ordered by id (or the key above), never by the order they arrived in: a database that returns
// rows in a different order must not change the draft or its hash. A source with no destination (vitals on
// a template with no vitals section) is not drafted; a source that yields no sentence (a vitals set with no
// values, a scale with no phrase in v1) is not a source, so it cannot make an empty section look sourced.
//
// Every sentence is a corpus phrase from `@chartwarden/narrative-vocab`, interpolated with values taken from
// structured fields (VN-D6): "changes since the last visit" are read off the reading's `previous` value and
// date, never from prior note text.
import { getVocabEntry } from "@chartwarden/narrative-vocab";
import type { ScaleType } from "@chartwarden/types";
import { HearthnoteAssemblyError } from "../assembly/assemble";
import { finishSentence, interpolate } from "../assembly/grammar";
import type { SlotValue } from "../assembly/types";
import type {
  CarePlanDraftInput,
  DraftInputs,
  DraftSourceBase,
  DraftSourceRef,
  MedicationChangeInput,
  MedicationChangeKind,
  ScaleReadingInput,
  VitalsDraftInput,
} from "./types";
import {
  DraftInputError,
  decimalText,
  finiteNumber,
  instantMs,
  isoDate,
  nonBlank,
  sentenceText,
} from "./validate";

/** One source and the sentences it produced. */
export interface SourceGroup {
  readonly ref: DraftSourceRef;
  readonly sentences: readonly string[];
  /** Raw flag as supplied; the compiler reads it fail closed (`=== false` is the only safe value). */
  readonly sudRelated: DraftSourceBase["sudRelated"];
}

const SECTION = {
  vitals: "vitals_review",
  assessment: "assessment",
  symptoms: "symptom_management",
  interventions: "interventions",
  plan: "plan",
} as const;

type SlotMap = Readonly<Record<string, SlotValue>>;

const VITAL_CODES = {
  bp: "nv.vit.bp",
  hr: "nv.vit.hr",
  rr: "nv.vit.rr",
  temp: "nv.vit.temp",
  spo2: "nv.vit.spo2",
  pain: "nv.vit.pain",
} as const;

const CARE_PLAN_CODES = {
  goalListed: "nv.cp.goal_listed",
  goalProgress: "nv.cp.goal_progress",
  interventionPerformed: "nv.cp.intervention_performed",
} as const;

/** Render one corpus phrase as a finished sentence. */
function sentence(code: string, params: SlotMap): string {
  const entry = getVocabEntry(code);
  if (entry === undefined) {
    throw new HearthnoteAssemblyError(
      "UNKNOWN_VOCAB_CODE",
      `draft phrase '${code}' is not in the corpus`,
    );
  }
  return finishSentence(interpolate(entry.phrase, params));
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A copy sorted by the keys `keyOf` returns, compared left to right; the input is never reordered. */
function sortedBy<T>(items: readonly T[], keyOf: (item: T) => readonly string[]): readonly T[] {
  return [...items].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    for (let i = 0; i < ka.length; i++) {
      const c = byCodeUnit(ka[i] ?? "", kb[i] ?? "");
      if (c !== 0) return c;
    }
    return 0;
  });
}

const group = (
  kind: DraftSourceRef["kind"],
  source: DraftSourceBase,
  sentences: readonly string[],
): SourceGroup => ({
  ref: { kind, id: nonBlank(source.id, `${kind} id`) },
  sentences,
  sudRelated: source.sudRelated,
});

// ── scale readings ─────────────────────────────────────────────────────────────────────────────────
interface ScaleSpec {
  readonly sectionId: string;
  readonly slot: "pps" | "esas";
  readonly labelled: boolean;
  readonly codes: Readonly<Record<"first" | "down" | "up" | "same", string>>;
}

const SCALE_SPECS: Readonly<Partial<Record<ScaleType, ScaleSpec>>> = {
  pps: {
    sectionId: SECTION.assessment,
    slot: "pps",
    labelled: false,
    codes: {
      first: "nv.scale.pps_first",
      down: "nv.scale.pps_down",
      up: "nv.scale.pps_up",
      same: "nv.scale.pps_same",
    },
  },
  esas_r: {
    sectionId: SECTION.symptoms,
    slot: "esas",
    labelled: true,
    codes: {
      first: "nv.scale.esas_first",
      down: "nv.scale.esas_down",
      up: "nv.scale.esas_up",
      same: "nv.scale.esas_same",
    },
  },
};

function scaleGroup(reading: ScaleReadingInput, spec: ScaleSpec): SourceGroup {
  const where = `scale reading '${reading.id}'`;
  const value = finiteNumber(reading.value, `${where} value`);
  const { slot } = spec;
  const params: Record<string, SlotValue> = { [`${slot}_value`]: value };
  if (spec.labelled) params[`${slot}_label`] = nonBlank(reading.label, `${where} label`);
  const previous = reading.previous ?? null;
  let code = spec.codes.first;
  if (previous !== null) {
    const before = finiteNumber(previous.value, `${where} previous value`);
    params[`${slot}_previous_value`] = before;
    params[`${slot}_previous_date`] = isoDate(previous.recordedOn, `${where} previous date`);
    code = value < before ? spec.codes.down : value > before ? spec.codes.up : spec.codes.same;
  }
  return group("scale_reading", reading, [sentence(code, params)]);
}

function scaleGroups(
  readings: readonly ScaleReadingInput[],
  scale: ScaleType,
  asOfMs: number,
): readonly SourceGroup[] {
  const spec = SCALE_SPECS[scale];
  if (spec === undefined) return [];
  const asOf = readings
    .filter((r) => r.scaleType === scale)
    .filter((r) => instantMs(r.recordedAt, `scale reading '${r.id}' recordedAt`) <= asOfMs);
  return sortedBy(asOf, (r) => [r.label ?? "", r.id]).map((r) => scaleGroup(r, spec));
}

// ── vitals ─────────────────────────────────────────────────────────────────────────────────────────
function vitalsSentences(v: VitalsDraftInput): readonly string[] {
  const sentences: string[] = [];
  const num = (value: number | undefined, field: string): number | undefined =>
    value === undefined ? undefined : finiteNumber(value, `vitals ${field}`);
  const systolic = num(v.bpSystolic, "systolic");
  const diastolic = num(v.bpDiastolic, "diastolic");
  const heartRate = num(v.heartRate, "heart rate");
  const respiratoryRate = num(v.respiratoryRate, "respiratory rate");
  const spo2 = num(v.spo2, "oxygen saturation");
  const pain = num(v.painScore, "pain score");

  if (systolic !== undefined && diastolic !== undefined) {
    sentences.push(sentence(VITAL_CODES.bp, { bp_systolic: systolic, bp_diastolic: diastolic }));
  }
  if (heartRate !== undefined) sentences.push(sentence(VITAL_CODES.hr, { heart_rate: heartRate }));
  if (respiratoryRate !== undefined) {
    sentences.push(sentence(VITAL_CODES.rr, { respiratory_rate: respiratoryRate }));
  }
  if (v.temperature !== undefined) {
    const temperature = decimalText(v.temperature, "vitals temperature");
    if (v.temperatureUnit !== undefined && v.temperatureUnit !== "f" && v.temperatureUnit !== "c") {
      throw new DraftInputError("vitals temperature unit must be 'f' or 'c'");
    }
    if (v.temperatureUnit !== undefined) {
      sentences.push(
        sentence(VITAL_CODES.temp, {
          temperature,
          temperature_unit: v.temperatureUnit.toUpperCase(),
        }),
      );
    }
  }
  if (spo2 !== undefined) sentences.push(sentence(VITAL_CODES.spo2, { spo2 }));
  if (pain !== undefined) sentences.push(sentence(VITAL_CODES.pain, { pain_score: pain }));
  return sentences;
}

function vitalsGroups(vitals: VitalsDraftInput | null, asOfMs: number): readonly SourceGroup[] {
  if (vitals === null) return [];
  if (instantMs(vitals.recordedAt, "vitals recordedAt") > asOfMs) return [];
  const sentences = vitalsSentences(vitals);
  return sentences.length === 0 ? [] : [group("vitals", vitals, sentences)];
}

// ── care plan ──────────────────────────────────────────────────────────────────────────────────────
function goalGroups(carePlan: CarePlanDraftInput | null): readonly SourceGroup[] {
  return sortedBy(carePlan?.goals ?? [], (g) => [g.id]).map((goal) => {
    const goalText = sentenceText(goal.goalText, `care-plan goal '${goal.id}' text`);
    const progress = goal.progressStatement?.trim() ?? "";
    const text =
      progress.length === 0
        ? sentence(CARE_PLAN_CODES.goalListed, { goal_text: goalText })
        : sentence(CARE_PLAN_CODES.goalProgress, {
            goal_text: goalText,
            progress_statement: progress,
          });
    return group("care_plan_goal", goal, [text]);
  });
}

function interventionGroups(carePlan: CarePlanDraftInput | null): readonly SourceGroup[] {
  return sortedBy(carePlan?.interventions ?? [], (i) => [i.id]).map((intervention) =>
    group("care_plan_intervention", intervention, [
      sentence(CARE_PLAN_CODES.interventionPerformed, {
        intervention_text: sentenceText(
          intervention.interventionText,
          `care-plan intervention '${intervention.id}' text`,
        ),
      }),
    ]),
  );
}

// ── medication changes ─────────────────────────────────────────────────────────────────────────────
const MEDICATION_CODES: Readonly<Record<MedicationChangeKind, string>> = {
  started: "nv.med.started",
  changed: "nv.med.changed",
  discontinued: "nv.med.discontinued",
};

function medicationGroups(
  changes: readonly MedicationChangeInput[],
  asOfMs: number,
): readonly SourceGroup[] {
  const asOf = changes.filter(
    (m) => instantMs(m.changedAt, `medication change '${m.id}' changedAt`) <= asOfMs,
  );
  return sortedBy(asOf, (m) => [new Date(Date.parse(m.changedAt)).toISOString(), m.id]).map(
    (change) => {
      const code = MEDICATION_CODES[change.change];
      if (code === undefined)
        throw new DraftInputError(`medication change '${change.id}' has an unknown kind`);
      return group("medication_change", change, [
        sentence(code, {
          drug_name: nonBlank(change.drugName, `medication change '${change.id}' drug name`),
          change_date: isoDate(change.changedOn, `medication change '${change.id}' date`),
        }),
      ]);
    },
  );
}

const scaleCodesOf = (sectionId: string): readonly string[] =>
  Object.values(SCALE_SPECS).flatMap((spec) =>
    spec !== undefined && spec.sectionId === sectionId ? Object.values(spec.codes) : [],
  );

/**
 * The corpus phrases each section is drafted from: exactly the codes the builders above render. `scope.ts` reads the corpus's
 * encounter-type and discipline tags of these codes to decide which templates draft at all. A section absent here is never drafted.
 */
export const DRAFT_SECTION_PHRASES: Readonly<Record<string, readonly string[]>> = {
  [SECTION.vitals]: Object.values(VITAL_CODES),
  [SECTION.assessment]: scaleCodesOf(SECTION.assessment),
  [SECTION.symptoms]: scaleCodesOf(SECTION.symptoms),
  [SECTION.interventions]: [
    CARE_PLAN_CODES.interventionPerformed,
    ...Object.values(MEDICATION_CODES),
  ],
  [SECTION.plan]: [CARE_PLAN_CODES.goalListed, CARE_PLAN_CODES.goalProgress],
};

/** Every section that has at least one source, with its sources in order. Empty sections are absent. */
export function collectSourceGroups(
  inputs: DraftInputs,
  asOfMs: number,
): ReadonlyMap<string, readonly SourceGroup[]> {
  const entries: ReadonlyArray<readonly [string, readonly SourceGroup[]]> = [
    [SECTION.vitals, vitalsGroups(inputs.vitals, asOfMs)],
    [SECTION.assessment, scaleGroups(inputs.scaleReadings, "pps", asOfMs)],
    [SECTION.symptoms, scaleGroups(inputs.scaleReadings, "esas_r", asOfMs)],
    [
      SECTION.interventions,
      [
        ...interventionGroups(inputs.carePlan),
        ...medicationGroups(inputs.medicationChanges, asOfMs),
      ],
    ],
    [SECTION.plan, goalGroups(inputs.carePlan)],
  ];
  return new Map(entries.filter(([, groups]) => groups.length > 0));
}

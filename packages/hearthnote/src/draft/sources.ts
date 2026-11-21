// packages/hearthnote/src/draft/sources.ts — which source feeds which section, and the sentence each makes.
//
// SECTION -> SOURCE MAPPING (this file is the one place it is decided; one map PER TEMPLATE since S2, `SOURCE_MAPS` below):
//
// The RN routine visit (S1):
//
//   section              fed by                                              ordering inside the section
//   chief_concern        nothing: no automatic source in v1, always empty    -
//   vitals_review        the visit's vitals                                  fixed: BP, HR, RR, temp, SpO2, pain
//   assessment           PPS scale readings                                  by source id
//   symptom_management   ESAS-r scale readings                               by label, then source id
//   interventions        care-plan interventions, then medication changes    by source id; changes by time, then id
//   plan                 care-plan goals (with progress when one is stated)  by source id
//
// The RN recertification visit (S2, design §3.3): vitals_review, interventions and plan as above, and
//   pps                  PPS readings, compared with the previous reading, else the benefit period's first   by source id
//   esas                 ESAS-r readings                                                                       by label, then source id
//   prognosis            PPS against the benefit period's first reading, weight, the attested face-to-face    in that order
//   recert_summary       the benefit period and level of care, then the signed certification                   in that order
//   (`assessment` and `symptom_management` draft nothing here: the recert phrase map gives them no phrase, though the PPS and ESAS-r
//   phrases are tagged for the template, because `pps` and `esas` are built from them.)
// The RN admission visit (S2b): vitals_review, interventions and plan as above, and
//   baseline_symptoms    ESAS-r readings                                                                       by label, then source id
//   med_reconciliation   the orders in effect at the visit (name, strength, form, route; as needed)            by drug name, then id
//   advance_directive    the advance directive acknowledgment that was on file (the fact, never its content)   one source
//   caregiver_overview   the caregivers on record on the service date (name and relationship, no contact)      primary first, then by name
//   (`assessment` and `symptom_management` draft nothing here, for the reason the recertification's do not.)
// The face-to-face visit (S2, `md` and `np`): prognosis from the PPS against the period's first reading, then the weight.
// The LPN visits (S3, `routine_visit` and `lpn_visit` by an LPN) are sourced like the routine visit; the corpus tags leave out the PPS and ESAS-r
// phrases, so `assessment` and `symptom_management` are not drafted for them (VN-D39).
// The aide visit (S3, `chha_visit` by a `chha`): adl     the care plan's active aide interventions, less those the author removed   by source id
//   (the recorded ADLs are stated first in the section, by the compiler, as the recorded vitals' body measures are).
// Every other template is sourced like the routine visit; the corpus tags decide whether it drafts at all (`scope.ts`).
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
import { templateKey } from "../templates/types";
import type {
  AdvanceDirectiveAcknowledgmentInput,
  BenefitPeriodDraftInput,
  CarePlanDraftInput,
  CaregiverInput,
  DraftInputs,
  DraftSourceBase,
  DraftSourceNeeds,
  DraftSourceRef,
  FaceToFaceDraftInput,
  MedicationChangeInput,
  MedicationChangeKind,
  MedicationOrderInput,
  ScaleReadingInput,
  VitalsDraftInput,
  WeightDraftInput,
} from "./types";
import type { CaregiverRelationship } from "./validate";
import {
  DraftInputError,
  WEIGHT_UNITS,
  daysBetween,
  decimalText,
  finiteNumber,
  instantMs,
  isoDate,
  nonBlank,
  positiveDecimal,
  positiveInteger,
  sentenceText,
  tableValue,
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

/**
 * One reading as its sentence. `baselineFallback` (the recertification `pps` section, S2) compares with the benefit period's first
 * reading when there is no `previous`, so a reading never says "no earlier reading recorded" beside an earlier one.
 */
function scaleGroup(
  reading: ScaleReadingInput,
  spec: ScaleSpec,
  baselineFallback = false,
): SourceGroup {
  const where = `scale reading '${reading.id}'`;
  const value = finiteNumber(reading.value, `${where} value`);
  const { slot } = spec;
  const params: Record<string, SlotValue> = { [`${slot}_value`]: value };
  if (spec.labelled) params[`${slot}_label`] = nonBlank(reading.label, `${where} label`);
  const previous = reading.previous ?? (baselineFallback ? (reading.baseline ?? null) : null);
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
  baselineFallback = false,
): readonly SourceGroup[] {
  const spec = SCALE_SPECS[scale];
  if (spec === undefined) return [];
  const asOf = readings
    .filter((r) => r.scaleType === scale)
    .filter((r) => instantMs(r.recordedAt, `scale reading '${r.id}' recordedAt`) <= asOfMs);
  return sortedBy(asOf, (r) => [r.label ?? "", r.id]).map((r) =>
    scaleGroup(r, spec, baselineFallback),
  );
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

// ── recertification and face-to-face (S2, design §3.3, VN-D31 to VN-D34) ────────────────────────────
const RECERT_SECTION = {
  pps: "pps",
  esas: "esas",
  prognosis: "prognosis",
  summary: "recert_summary",
} as const;

const RECERT_CODES = {
  ppsBaseline: {
    down: "nv.rc.pps_baseline_down",
    up: "nv.rc.pps_baseline_up",
    same: "nv.rc.pps_baseline_same",
  },
  weight: {
    only: "nv.rc.weight_first",
    down: "nv.rc.weight_down",
    up: "nv.rc.weight_up",
    same: "nv.rc.weight_same",
  },
  faceToFace: "nv.rc.f2f",
  period: "nv.rc.period",
  levelOfCare: "nv.rc.level_of_care",
  certification: "nv.rc.cti_signed",
} as const;

const LEVEL_OF_CARE_WORDS: Readonly<Record<string, string>> = {
  routine_home_care: "routine home care",
  continuous_home_care: "continuous home care",
  inpatient_respite_care: "inpatient respite care",
  general_inpatient_care: "general inpatient care",
};
const PERIOD_LENGTH_DAYS: Readonly<Record<string, number>> = { ninety_day: 90, sixty_day: 60 };
const PERFORMER_WORDS: Readonly<Record<string, string>> = {
  hospice_md: "physician",
  hospice_np: "nurse practitioner",
};
const WEIGHT_UNIT_WORDS: Readonly<Record<string, string>> = Object.fromEntries(
  WEIGHT_UNITS.map((unit) => [unit, unit]),
);

/** The PPS reading against the benefit period's first reading, for a reading that carries one (the `prognosis` section). */
function ppsBaselineGroups(
  readings: readonly ScaleReadingInput[],
  asOfMs: number,
): readonly SourceGroup[] {
  const asOf = readings
    .filter((r) => r.scaleType === "pps")
    .filter((r) => instantMs(r.recordedAt, `scale reading '${r.id}' recordedAt`) <= asOfMs);
  return sortedBy(asOf, (r) => [r.id]).flatMap((reading) => {
    const baseline = reading.baseline ?? null;
    if (baseline === null) return [];
    const where = `scale reading '${reading.id}'`;
    const value = finiteNumber(reading.value, `${where} value`);
    const before = finiteNumber(baseline.value, `${where} baseline value`);
    const { down, up, same } = RECERT_CODES.ppsBaseline;
    return [
      group("scale_reading", reading, [
        sentence(value < before ? down : value > before ? up : same, {
          pps_value: value,
          pps_baseline_value: before,
          pps_baseline_date: isoDate(baseline.recordedOn, `${where} baseline date`),
        }),
      ]),
    ];
  });
}

/** The latest weight, beside the benefit period's first when there is one. Validated whole before the as-of cut, like every source. */
function weightGroups(
  weight: WeightDraftInput | null | undefined,
  asOfMs: number,
): readonly SourceGroup[] {
  if (weight === null || weight === undefined) return [];
  const where = `weight reading '${weight.id}'`;
  const recordedMs = instantMs(weight.recordedAt, `${where} recordedAt`);
  const unit = tableValue(WEIGHT_UNIT_WORDS, weight.unit, `${where} unit`);
  const latest = positiveDecimal(weight.value, `${where} value`);
  const recordedOn = isoDate(weight.recordedOn, `${where} date`);
  const first = weight.baseline ?? null;
  const baseline =
    first === null
      ? null
      : {
          ...positiveDecimal(first.value, `${where} baseline value`),
          on: isoDate(first.recordedOn, `${where} baseline date`),
        };
  if (recordedMs > asOfMs) return [];
  const params: Record<string, SlotValue> = {
    weight_value: latest.text,
    weight_unit: unit,
    weight_date: recordedOn,
  };
  const { only, down, up, same } = RECERT_CODES.weight;
  if (baseline === null) return [group("weight_reading", weight, [sentence(only, params)])];
  const code = latest.amount < baseline.amount ? down : latest.amount > baseline.amount ? up : same;
  const percent = ((Math.abs(latest.amount - baseline.amount) / baseline.amount) * 100).toFixed(1);
  return [
    group("weight_reading", weight, [
      sentence(code, {
        ...params,
        weight_baseline_value: baseline.text,
        weight_baseline_date: baseline.on,
        weight_change_percent: percent,
      }),
    ]),
  ];
}

/** The attested face-to-face as a group, or none when it was attested after the service date (VN-D11). Validated either way. */
function faceToFaceGroups(
  f2f: FaceToFaceDraftInput | null,
  serviceDate: string,
  where: string,
): readonly SourceGroup[] {
  if (f2f === null) return [];
  const label = `${where} face-to-face '${f2f.id}'`;
  const performer = tableValue(PERFORMER_WORDS, f2f.performerRole, `${label} performer`);
  const performedOn = isoDate(f2f.performedOn, `${label} date`);
  const attestedOn = isoDate(f2f.attestedOn, `${label} attestation date`);
  if (attestedOn > serviceDate) return [];
  return [
    group("face_to_face", f2f, [
      sentence(RECERT_CODES.faceToFace, {
        f2f_performer: performer,
        f2f_performed_on: performedOn,
        f2f_attested_on: attestedOn,
      }),
    ]),
  ];
}

/** The benefit period on the service date: the summary groups, and the face-to-face group the `prognosis` section reads. */
function recertPeriodGroups(
  period: BenefitPeriodDraftInput | null | undefined,
  serviceDate: string,
): { readonly summary: readonly SourceGroup[]; readonly faceToFace: readonly SourceGroup[] } {
  if (period === null || period === undefined) return { summary: [], faceToFace: [] };
  const where = `benefit period '${period.id}'`;
  const sequence = positiveInteger(period.sequence, `${where} sequence`);
  const length = tableValue(PERIOD_LENGTH_DAYS, period.periodKind, `${where} kind`);
  const start = isoDate(period.startDate, `${where} start date`);
  const end = isoDate(period.endDate, `${where} end date`);
  // `null` is "not determinable for the service date": its sentence is left out, the rest of the summary stands.
  const levelOfCare =
    period.levelOfCare === null
      ? null
      : tableValue(LEVEL_OF_CARE_WORDS, period.levelOfCare, `${where} level of care`);
  if (serviceDate < start || serviceDate > end) {
    throw new DraftInputError(`${where} does not contain the service date`);
  }
  const faceToFace = faceToFaceGroups(period.faceToFace, serviceDate, where);
  const cti = period.certification;
  let certification: readonly SourceGroup[] = [];
  if (cti !== null) {
    const signedOn = isoDate(cti.signedOn, `${where} certification date`);
    certification =
      signedOn > serviceDate
        ? []
        : [
            group("certification", cti, [
              sentence(RECERT_CODES.certification, { cti_signed_on: signedOn }),
            ]),
          ];
  }
  return {
    summary: [
      group("benefit_period", period, [
        sentence(RECERT_CODES.period, {
          period_sequence: sequence,
          period_length: length,
          period_start: start,
          period_end: end,
          period_day: daysBetween(start, serviceDate) + 1,
        }),
        ...(levelOfCare === null
          ? []
          : [sentence(RECERT_CODES.levelOfCare, { level_of_care: levelOfCare })]),
      ]),
      ...certification,
    ],
    faceToFace,
  };
}

// ── RN admission visit (S2b, design §3.3, VN-D35 to VN-D38) ─────────────────────────────────────────
const ADMISSION_SECTION = {
  medications: "med_reconciliation",
  advanceDirective: "advance_directive",
  caregivers: "caregiver_overview",
  symptoms: "baseline_symptoms",
} as const;

const ADMISSION_CODES = {
  medication: "nv.adm.med_active",
  medicationAsNeeded: "nv.adm.med_active_prn",
  acknowledgment: "nv.adm.ad_ack_on_file",
  caregiverPrimary: "nv.adm.caregiver_primary",
  caregiverOther: "nv.adm.caregiver_other",
} as const;

/** The words for M5's caregiver relationships (`patient_caregiver.relationship`); a value it does not hold is a malformed input. */
const RELATIONSHIP_WORDS: Readonly<Record<CaregiverRelationship, string>> = {
  spouse: "spouse",
  child: "child",
  parent: "parent",
  sibling: "sibling",
  other_family: "other family member",
  friend: "friend",
  guardian: "guardian",
  paid_caregiver: "paid caregiver",
};

/** The orders in effect at the visit: what each is and how it is taken, in drug-name order. No frequency and no word about reconciliation. */
function medicationOrderGroups(
  orders: readonly MedicationOrderInput[] | undefined,
): readonly SourceGroup[] {
  return sortedBy(orders ?? [], (o) => [o.drugName, o.id]).map((order) => {
    const where = `medication order '${order.id}'`;
    if (typeof order.asNeeded !== "boolean") {
      throw new DraftInputError(`${where} as-needed flag must be true or false`);
    }
    return group("medication_order", order, [
      sentence(order.asNeeded ? ADMISSION_CODES.medicationAsNeeded : ADMISSION_CODES.medication, {
        drug_name: nonBlank(order.drugName, `${where} drug name`),
        strength: nonBlank(order.strength, `${where} strength`),
        dose_form: nonBlank(order.doseForm, `${where} dose form`),
        route: nonBlank(order.route, `${where} route`),
      }),
    ]);
  });
}

/** The acknowledgment that was on file: the fact that it was, and nothing about what it says. */
function advanceDirectiveGroups(
  acknowledgment: AdvanceDirectiveAcknowledgmentInput | null | undefined,
): readonly SourceGroup[] {
  if (acknowledgment === null || acknowledgment === undefined) return [];
  return [
    group("advance_directive_acknowledgment", acknowledgment, [
      sentence(ADMISSION_CODES.acknowledgment, {}),
    ]),
  ];
}

/** The caregivers on record: the primary first, then the others by name. The name and the relationship only, never a contact detail. */
function caregiverGroups(
  caregivers: readonly CaregiverInput[] | undefined,
): readonly SourceGroup[] {
  return sortedBy(caregivers ?? [], (c) => [
    c.isPrimary === true ? "0" : "1",
    c.displayName,
    c.id,
  ]).map((caregiver) => {
    const where = `caregiver '${caregiver.id}'`;
    return group("caregiver", caregiver, [
      sentence(
        caregiver.isPrimary === true
          ? ADMISSION_CODES.caregiverPrimary
          : ADMISSION_CODES.caregiverOther,
        {
          caregiver_name: nonBlank(caregiver.displayName, `${where} name`),
          caregiver_relationship: tableValue(
            RELATIONSHIP_WORDS,
            caregiver.relationship,
            `${where} relationship`,
          ),
        },
      ),
    ]);
  });
}

// ── one map per template ───────────────────────────────────────────────────────────────────────────
type SectionGroups = ReadonlyArray<readonly [string, readonly SourceGroup[]]>;
type SourceMap = (inputs: DraftInputs, asOfMs: number) => SectionGroups;

/** The sections both the routine visit and the recertification source the same way: vitals, interventions, plan. */
const baseGroups = (inputs: DraftInputs, asOfMs: number): SectionGroups => [
  [SECTION.vitals, vitalsGroups(inputs.vitals, asOfMs)],
  [
    SECTION.interventions,
    [...interventionGroups(inputs.carePlan), ...medicationGroups(inputs.medicationChanges, asOfMs)],
  ],
  [SECTION.plan, goalGroups(inputs.carePlan)],
];

const routineVisitMap: SourceMap = (inputs, asOfMs) => [
  ...baseGroups(inputs, asOfMs),
  [SECTION.assessment, scaleGroups(inputs.scaleReadings, "pps", asOfMs)],
  [SECTION.symptoms, scaleGroups(inputs.scaleReadings, "esas_r", asOfMs)],
];

const recertVisitMap: SourceMap = (inputs, asOfMs) => {
  const period = recertPeriodGroups(
    inputs.benefitPeriod,
    isoDate(inputs.context.serviceDate, "service date"),
  );
  return [
    ...baseGroups(inputs, asOfMs),
    [RECERT_SECTION.pps, scaleGroups(inputs.scaleReadings, "pps", asOfMs, true)],
    [RECERT_SECTION.esas, scaleGroups(inputs.scaleReadings, "esas_r", asOfMs)],
    [
      RECERT_SECTION.prognosis,
      [
        ...ppsBaselineGroups(inputs.scaleReadings, asOfMs),
        ...weightGroups(inputs.weight, asOfMs),
        ...period.faceToFace,
      ],
    ],
    [RECERT_SECTION.summary, period.summary],
  ];
};

const admissionVisitMap: SourceMap = (inputs, asOfMs) => [
  ...baseGroups(inputs, asOfMs),
  [ADMISSION_SECTION.symptoms, scaleGroups(inputs.scaleReadings, "esas_r", asOfMs)],
  [ADMISSION_SECTION.medications, medicationOrderGroups(inputs.activeMedications)],
  [ADMISSION_SECTION.advanceDirective, advanceDirectiveGroups(inputs.advanceDirective)],
  [ADMISSION_SECTION.caregivers, caregiverGroups(inputs.caregivers)],
];

const faceToFaceVisitMap: SourceMap = (inputs, asOfMs) => [
  [
    RECERT_SECTION.prognosis,
    [...ppsBaselineGroups(inputs.scaleReadings, asOfMs), ...weightGroups(inputs.weight, asOfMs)],
  ],
];

/** S3: the aide visit's one drafted section. */
const AIDE_SECTION = { adl: "adl" } as const;

/** The aide visit (S3): the care-plan interventions linked to it, in `adl`. No goal, vitals, scale or medication source is read. */
const aideVisitMap: SourceMap = (inputs) => [
  [AIDE_SECTION.adl, interventionGroups(inputs.carePlan)],
];

/** The templates S2 and S3 source differently from the routine visit. Every other template is sourced like the routine visit (S1's rule). */
const SOURCE_MAPS: ReadonlyMap<string, SourceMap> = new Map([
  [templateKey("recert_visit", "rn"), recertVisitMap],
  [templateKey("admission_visit", "rn"), admissionVisitMap],
  [templateKey("face_to_face", "md"), faceToFaceVisitMap],
  [templateKey("face_to_face", "np"), faceToFaceVisitMap],
  [templateKey("chha_visit", "chha"), aideVisitMap],
]);

const scaleCodesOf = (sectionId: string): readonly string[] =>
  Object.values(SCALE_SPECS).flatMap((spec) =>
    spec !== undefined && spec.sectionId === sectionId ? Object.values(spec.codes) : [],
  );

const baseSectionPhrases: Readonly<Record<string, readonly string[]>> = {
  [SECTION.vitals]: Object.values(VITAL_CODES),
  [SECTION.interventions]: [
    CARE_PLAN_CODES.interventionPerformed,
    ...Object.values(MEDICATION_CODES),
  ],
  [SECTION.plan]: [CARE_PLAN_CODES.goalListed, CARE_PLAN_CODES.goalProgress],
};

const prognosisEvidencePhrases: readonly string[] = [
  ...Object.values(RECERT_CODES.ppsBaseline),
  ...Object.values(RECERT_CODES.weight),
];

const recertScaleCodes = (scale: ScaleType): readonly string[] =>
  Object.values(SCALE_SPECS[scale]?.codes ?? {});

const ROUTINE_SECTION_PHRASES: Readonly<Record<string, readonly string[]>> = {
  ...baseSectionPhrases,
  [SECTION.assessment]: scaleCodesOf(SECTION.assessment),
  [SECTION.symptoms]: scaleCodesOf(SECTION.symptoms),
};

/**
 * The corpus phrases each section of a template is drafted from: exactly the codes the builders above render. `scope.ts` reads the
 * corpus's encounter-type and discipline tags of these codes to decide which templates draft at all. A section absent here is never
 * drafted. The recertification and the face-to-face visit have maps of their own; every other template is read as the routine visit
 * (S1), so tagging those phrases for another pair is still all it takes to make that pair draft.
 */
const SECTION_PHRASES: ReadonlyMap<string, Readonly<Record<string, readonly string[]>>> = new Map<
  string,
  Readonly<Record<string, readonly string[]>>
>([
  [
    templateKey("recert_visit", "rn"),
    {
      ...baseSectionPhrases,
      [RECERT_SECTION.pps]: recertScaleCodes("pps"),
      [RECERT_SECTION.esas]: recertScaleCodes("esas_r"),
      [RECERT_SECTION.prognosis]: [...prognosisEvidencePhrases, RECERT_CODES.faceToFace],
      [RECERT_SECTION.summary]: [
        RECERT_CODES.period,
        RECERT_CODES.levelOfCare,
        RECERT_CODES.certification,
      ],
    },
  ],
  [
    templateKey("admission_visit", "rn"),
    {
      ...baseSectionPhrases,
      [ADMISSION_SECTION.symptoms]: recertScaleCodes("esas_r"),
      [ADMISSION_SECTION.medications]: [
        ADMISSION_CODES.medication,
        ADMISSION_CODES.medicationAsNeeded,
      ],
      [ADMISSION_SECTION.advanceDirective]: [ADMISSION_CODES.acknowledgment],
      [ADMISSION_SECTION.caregivers]: [
        ADMISSION_CODES.caregiverPrimary,
        ADMISSION_CODES.caregiverOther,
      ],
    },
  ],
  [templateKey("face_to_face", "md"), { [RECERT_SECTION.prognosis]: prognosisEvidencePhrases }],
  [templateKey("face_to_face", "np"), { [RECERT_SECTION.prognosis]: prognosisEvidencePhrases }],
  [
    templateKey("chha_visit", "chha"),
    { [AIDE_SECTION.adl]: [CARE_PLAN_CODES.interventionPerformed] },
  ],
]);

/** The phrases each section of the template with this key is drafted from. */
export function draftSectionPhrases(key: string): Readonly<Record<string, readonly string[]>> {
  return SECTION_PHRASES.get(key) ?? ROUTINE_SECTION_PHRASES;
}

const SOURCE_NAMES = ["carePlan", "vitals", "medicationChanges", "scales"] as const;

/**
 * The S1 sources each drafted section is built from (S3). One row per section id any template drafts; a template reads the union over the
 * sections it drafts (`draftSourceNeeds` in scope.ts), and the S2 and S2b records are decided by encounter type, so those rows are empty.
 * `prognosis` is the PPS against the period's first reading, then the weight (the weight is the S2 record).
 */
const SECTION_SOURCES: Readonly<Record<string, readonly (typeof SOURCE_NAMES)[number][]>> = {
  [SECTION.vitals]: ["vitals"],
  [SECTION.assessment]: ["scales"],
  [SECTION.symptoms]: ["scales"],
  [SECTION.interventions]: ["carePlan", "medicationChanges"],
  [SECTION.plan]: ["carePlan"],
  [AIDE_SECTION.adl]: ["carePlan"],
  [RECERT_SECTION.pps]: ["scales"],
  [RECERT_SECTION.esas]: ["scales"],
  [RECERT_SECTION.prognosis]: ["scales"],
  [RECERT_SECTION.summary]: [],
  [ADMISSION_SECTION.symptoms]: ["scales"],
  [ADMISSION_SECTION.medications]: [],
  [ADMISSION_SECTION.advanceDirective]: [],
  [ADMISSION_SECTION.caregivers]: [],
};

/**
 * The S1 sources the given drafted sections need read. Throws for a section with no row above: a section the corpus can draft must say which
 * sources feed it, or the backend would read none of them (a draft silently short of its sources).
 */
export function sourceNeedsOf(sectionIds: Iterable<string>): DraftSourceNeeds {
  const needed = new Set<string>();
  for (const id of sectionIds) {
    const sources = SECTION_SOURCES[id];
    if (sources === undefined) throw new Error(`draft section '${id}' declares no sources`);
    for (const source of sources) needed.add(source);
  }
  return {
    carePlan: needed.has("carePlan"),
    vitals: needed.has("vitals"),
    medicationChanges: needed.has("medicationChanges"),
    scales: needed.has("scales"),
  };
}

/** Every section of the inputs' template that has at least one source, with its sources in order. Empty sections are absent. */
export function collectSourceGroups(
  inputs: DraftInputs,
  asOfMs: number,
): ReadonlyMap<string, readonly SourceGroup[]> {
  const build =
    SOURCE_MAPS.get(templateKey(inputs.encounterType, inputs.discipline)) ?? routineVisitMap;
  return new Map(build(inputs, asOfMs).filter(([, groups]) => groups.length > 0));
}

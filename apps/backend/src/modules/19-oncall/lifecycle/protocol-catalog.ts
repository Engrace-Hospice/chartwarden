// apps/backend/src/modules/19-oncall/lifecycle/protocol-catalog.ts — M19-T03 (§1.1, §3.2 Phase E, D4, D7).
//
// THE PLATFORM FLOOR. §1.1 enumerates the ≥25 protocols Phase 1 ships covering the hospice industry's
// high-frequency after-hours presentations, and §3.2 Phase E seeds them as `triage_protocol` rows with
// `organization_id IS NULL` + `is_system_locked = true`. Every tenant READS them (migration 0108's SELECT
// policy admits the org-less row) and no tenant can write them (INSERT/UPDATE admit only its own unlocked
// rows) — D4's floor-plus-overlay, the M21 `comfort_kit_template` precedent.
//
// This file is the SOURCE OF TRUTH for that seed. Migration 0109 is generated from it, and
// `oncall-protocol-catalog.test.ts` re-derives every id, key, tier and question from here and asserts the
// SQL matches — because a catalog that drifts from its own seed is a catalog whose red-flag predicates
// describe questions the database does not have.
//
// ── THE COUNT (28, where §1.1 says ≥25) ──────────────────────────────────────────────────────────────
// §1.1's prose enumerates 26 presentations. Two reads added the 27th and 28th:
//   • `uncontrolled_pain` carries "(with PAINAD/FLACC sub-branches per dementia status)". A single protocol
//     cannot ask both a 0–10 self-report and an observational PAINAD scale — the answer TYPE differs — so
//     the floor ships two protocols and the panel picks by the patient's dementia status.
//   • D7's fourth mandatory-escalation trigger is "a hospice-medical-emergency drug request that the
//     on-call RN cannot fulfill from comfort kit (always to medical director)". §1.1 lists
//     `comfort_kit_access_question` separately, and making THAT protocol mandatory-escalate would page the
//     medical director for "where is the lockbox key?" every time. The two are therefore distinct rows and
//     only `emergency_drug_request_unfulfillable` carries the mandatory flag.
// The four D7 mandatory protocols are exactly §1.1's list: suicidal ideation, unresponsive patient
// (code blue), suspected abuse/neglect, and the unfulfillable emergency drug request.
//
// ── SNOMED CODES ARE PROVISIONAL, AND SAID SO ────────────────────────────────────────────────────────
// §3.3 types `snomed_code` as an "M38-validated SNOMED finding/symptom code" resolved through an
// `asOfDate` lookup. M38's terminology package declares the `snomed` code-system kind but the corpus
// carries no loaded SNOMED value set today, so the floor seeds only concept ids that are unambiguous and
// widely published, and every OPERATIONAL protocol (a DME malfunction and an IV-pump alarm are not clinical
// findings) plus the handful with no single clean finding concept carries `SNOMED_UNSPECIFIED`
// (74964007, "Other"). Guessing a plausible-looking id would be worse than an explicit generic: a wrong
// code is indistinguishable from a right one downstream, and it would flow into `triage_call.
// chief_complaint_snomed`, the §4.3 `TriageCallFeatureDto` and M28's FHIR projection. M19-T07's catalog
// route validates each code through M38 before a tenant may reference it; filling these in is a value-set
// task, not a code change.
import type {
  TriageEscalationTier,
  TriageProtocolAnswerType,
  TriageRedFlagMatch,
} from "@chartwarden/types";
import type { TriageActorDiscipline } from "./protocol";

/** SNOMED CT "Other" — the honest placeholder for a floor protocol with no loaded finding concept. */
export const SNOMED_UNSPECIFIED = "74964007";

/** One seeded question of a floor protocol. */
export interface CatalogQuestion {
  readonly id: string;
  readonly order: number;
  readonly prompt: string;
  readonly answerType: TriageProtocolAnswerType;
  readonly answerEnumValues: readonly string[] | null;
  readonly required: boolean;
  readonly isRedFlagQuestion: boolean;
  readonly redFlagMatch: TriageRedFlagMatch | null;
}

/** One seeded platform-floor protocol. */
export interface CatalogProtocol {
  readonly id: string;
  readonly key: string;
  readonly chiefComplaintLabel: string;
  readonly snomedCode: string;
  readonly disciplineRequired: TriageActorDiscipline;
  readonly requiresMandatoryEscalation: boolean;
  readonly mandatoryEscalationTier: TriageEscalationTier | null;
  readonly sortOrder: number;
  readonly questions: readonly CatalogQuestion[];
}

/** Deterministic protocol uuid — `00000000-0019-0000-0000-0000000000NN` (the M21 seed's shape, with the
 *  module number in the second group so an id read in a log says which module owns it). */
const protocolId = (n: number): string => `00000000-0019-0000-0000-${String(n).padStart(12, "0")}`;

/** Deterministic question uuid — `00000000-0019-0001-PPQQ-000000000000`. */
const questionId = (p: number, q: number): string =>
  `00000000-0019-0001-${String(p).padStart(2, "0")}${String(q).padStart(2, "0")}-000000000000`;

/** Terse question builders. Every floor question is `required` — the floor is the minimum walk, and a
 *  question a clinician may skip is one a tenant could have added instead. */
type QBuilder = (p: number, q: number) => CatalogQuestion;

const ask = (
  prompt: string,
  answerType: TriageProtocolAnswerType,
  extra: {
    readonly enumValues?: readonly string[];
    readonly redFlag?: TriageRedFlagMatch;
  } = {},
): QBuilder => {
  return (p, q) => ({
    id: questionId(p, q),
    order: q,
    prompt,
    answerType,
    answerEnumValues: extra.enumValues ?? null,
    required: true,
    isRedFlagQuestion: extra.redFlag !== undefined,
    redFlagMatch: extra.redFlag ?? null,
  });
};

/** `boolean` question whose YES is the red flag — by far the commonest floor shape. */
const askYesIsFlag = (prompt: string): QBuilder =>
  ask(prompt, "boolean", { redFlag: { kind: "bool_is", value: true } });

/** `boolean` question with no flag. */
const askYesNo = (prompt: string): QBuilder => ask(prompt, "boolean");

/** 0–10 scale whose upper band is the red flag. */
const askScaleAtLeast = (prompt: string, threshold: number): QBuilder =>
  ask(prompt, "scale_0_10", { redFlag: { kind: "int_at_least", threshold } });

/** Free text that always records (never a flag by itself). */
const askText = (prompt: string): QBuilder => ask(prompt, "free_text");

interface ProtocolSpec {
  readonly key: string;
  readonly label: string;
  readonly snomed: string;
  readonly discipline: TriageActorDiscipline;
  readonly mandatoryTier?: TriageEscalationTier;
  readonly questions: readonly QBuilder[];
}

/**
 * §1.1 — the floor, in the order §1.1 lists it. `discipline` is the FLOOR the protocol may be run at, not
 * a restriction on who else may: `disciplineSatisfies` lets an RN run an LPN or MSW protocol, which is the
 * ordinary case at 2 a.m. The cardiac, stroke, unresponsive and death protocols floor at `clinical_rn`
 * because an LPN walking them would reach a disposition their scope of practice cannot support (§7.3).
 */
const SPECS: readonly ProtocolSpec[] = [
  {
    key: "uncontrolled_pain",
    label: "Uncontrolled pain (self-report)",
    snomed: "22253000",
    discipline: "clinical_lpn",
    questions: [
      askScaleAtLeast("Pain level 0–10 as reported by the patient or caregiver?", 7),
      askYesNo("Has a PRN analgesic been given in the last 4 hours?"),
      askYesIsFlag("Is this pain new, or different in character from the usual pain?"),
      askText("What has been tried so far, and with what effect?"),
    ],
  },
  {
    key: "uncontrolled_pain_dementia",
    label: "Uncontrolled pain — non-verbal / dementia (PAINAD)",
    snomed: "22253000",
    discipline: "clinical_lpn",
    questions: [
      askScaleAtLeast("PAINAD total score (0–10) from the caregiver's observation?", 7),
      askYesNo("Has a PRN analgesic been given in the last 4 hours?"),
      askYesIsFlag("Is the patient resisting care or unable to be consoled?"),
      askText("Which PAINAD behaviours is the caregiver seeing?"),
    ],
  },
  {
    key: "dyspnea",
    label: "Dyspnea / shortness of breath",
    snomed: "267036007",
    discipline: "clinical_lpn",
    questions: [
      askScaleAtLeast("Breathlessness 0–10 as the patient or caregiver rates it?", 7),
      askYesIsFlag("Is the patient unable to speak a full sentence?"),
      askYesNo("Is supplemental oxygen in use and working?"),
      askYesNo("Has a PRN opioid or anxiolytic been given for breathlessness?"),
    ],
  },
  {
    key: "terminal_agitation",
    label: "Terminal agitation / restlessness / delirium",
    snomed: "24199005",
    discipline: "clinical_lpn",
    questions: [
      askYesNo("When was the last bowel movement — within the last 3 days?"),
      askYesNo("Has the patient passed urine in the last 8 hours?"),
      askYesIsFlag("Is the patient at risk of harming themselves or the caregiver right now?"),
      askText("What is the patient doing that the caregiver is calling about?"),
    ],
  },
  {
    key: "nausea_vomiting",
    label: "Nausea and vomiting",
    snomed: "16932000",
    discipline: "clinical_lpn",
    questions: [
      askYesIsFlag("Has the patient vomited a scheduled medication in the last 4 hours?"),
      askYesIsFlag("Is there blood or coffee-ground material in the vomit?"),
      askYesNo("Has a PRN antiemetic been given?"),
      askText("How many episodes, and over what period?"),
    ],
  },
  {
    key: "constipation_impaction",
    label: "Constipation / suspected impaction",
    snomed: "14760008",
    discipline: "clinical_lpn",
    questions: [
      ask("Days since the last bowel movement?", "integer", {
        redFlag: { kind: "int_at_least", threshold: 4 },
      }),
      askYesIsFlag("Is the abdomen distended, firm or painful to touch?"),
      askYesNo("Has the prescribed bowel regimen been given as ordered?"),
      askText("What has the caregiver already tried?"),
    ],
  },
  {
    key: "urinary_retention_foley",
    label: "Urinary retention / catheter problem",
    snomed: "267064002",
    discipline: "clinical_lpn",
    questions: [
      askYesIsFlag("Has the patient passed no urine in the last 8 hours?"),
      askYesNo("Is an indwelling catheter in place?"),
      askYesIsFlag("Is the catheter draining nothing, or is there frank blood in the bag?"),
      askText("What does the caregiver see or describe?"),
    ],
  },
  {
    key: "fall_no_injury",
    label: "Fall — no apparent injury",
    snomed: "1912002",
    discipline: "clinical_lpn",
    questions: [
      askYesIsFlag("Did the patient hit their head, or is a head strike unwitnessed?"),
      askYesNo("Is the patient back in a safe position now?"),
      askYesIsFlag("Is the patient on an anticoagulant?"),
      askText("How did the fall happen, as the caregiver describes it?"),
    ],
  },
  {
    key: "fall_with_injury",
    label: "Fall — with injury",
    snomed: "1912002",
    discipline: "clinical_rn",
    questions: [
      askText("What injury is visible or reported?"),
      askYesIsFlag("Is there deformity, an open wound, or inability to bear weight?"),
      askYesIsFlag("Did the patient hit their head, or is a head strike unwitnessed?"),
      askYesIsFlag("Is the patient on an anticoagulant?"),
    ],
  },
  {
    key: "suspected_aspiration",
    label: "Suspected aspiration",
    snomed: SNOMED_UNSPECIFIED,
    discipline: "clinical_rn",
    questions: [
      askYesIsFlag("Did the choking or coughing begin during eating, drinking or medication?"),
      askYesIsFlag("Is the patient still coughing, gurgling or struggling to breathe?"),
      askYesNo("Is the patient able to speak?"),
      askText("What was the patient taking by mouth at the time?"),
    ],
  },
  {
    key: "bleeding",
    label: "Bleeding",
    snomed: "131148009",
    discipline: "clinical_rn",
    questions: [
      askText("Where is the bleeding, and how did it start?"),
      askYesIsFlag("Is the bleeding soaking through dressings or not stopping with pressure?"),
      askYesIsFlag("Is the patient on an anticoagulant?"),
      askYesNo("Is a hospice bleeding-precaution kit (dark towels) at the bedside?"),
    ],
  },
  {
    key: "seizure",
    label: "Seizure",
    snomed: "91175000",
    discipline: "clinical_rn",
    questions: [
      askYesIsFlag("Is the patient still seizing now?"),
      ask("How many minutes did the seizure last?", "integer", {
        redFlag: { kind: "int_at_least", threshold: 5 },
      }),
      askYesNo("Has the patient had seizures before?"),
      askYesNo("Was a rescue medication (e.g. rectal or buccal benzodiazepine) given?"),
    ],
  },
  {
    key: "suspected_stroke",
    label: "Suspected stroke",
    snomed: "230690007",
    discipline: "clinical_rn",
    questions: [
      askYesIsFlag("Is there new facial droop, arm weakness, or slurred speech?"),
      askText("When was the patient last known to be at their usual baseline?"),
      askYesNo("Has the family been reminded of the hospice plan of care and code status?"),
      askYesIsFlag("Is the family requesting 911 transport?"),
    ],
  },
  {
    key: "chest_pain_suspected_mi",
    label: "Chest pain / suspected MI",
    snomed: "29857009",
    discipline: "clinical_rn",
    questions: [
      askScaleAtLeast("Chest pain 0–10?", 7),
      askYesIsFlag("Is the pain crushing, radiating, or with sweating and nausea?"),
      askYesNo("Is the chest pain a known, previously assessed symptom for this patient?"),
      askYesIsFlag("Is the family requesting 911 transport?"),
    ],
  },
  {
    key: "hypoglycemia",
    label: "Hypoglycemia",
    snomed: "302866003",
    discipline: "clinical_lpn",
    questions: [
      ask("Blood glucose reading (mg/dL), if measured?", "integer", {
        redFlag: { kind: "int_at_most", threshold: 60 },
      }),
      askYesIsFlag("Is the patient confused, sweating, or difficult to rouse?"),
      askYesNo("Is the patient able to swallow safely?"),
      askText("When did the patient last eat, and what?"),
    ],
  },
  {
    key: "hyperglycemia",
    label: "Hyperglycemia",
    snomed: "80394007",
    discipline: "clinical_lpn",
    questions: [
      ask("Blood glucose reading (mg/dL), if measured?", "integer", {
        redFlag: { kind: "int_at_least", threshold: 400 },
      }),
      askYesIsFlag("Is the patient breathing deeply and rapidly, or unusually drowsy?"),
      askYesNo("Has insulin been given as ordered?"),
      askText("What is the caregiver observing?"),
    ],
  },
  {
    key: "unresponsive_patient",
    label: "Unresponsive patient (code blue)",
    snomed: SNOMED_UNSPECIFIED,
    discipline: "clinical_rn",
    mandatoryTier: "tier_3_medical_director",
    questions: [
      askYesIsFlag("Is the patient unresponsive to voice and touch right now?"),
      askYesNo("Is the patient breathing?"),
      askText("What is the patient's documented code status, as the caregiver understands it?"),
      askText("When was the patient last responsive?"),
    ],
  },
  {
    key: "suspected_death",
    label: "Suspected death / pronouncement",
    snomed: "419620001",
    discipline: "clinical_rn",
    questions: [
      askYesNo("Was this death expected under the plan of care?"),
      askYesNo("Is the code status DNR, as documented?"),
      askYesIsFlag("Is there anything about the circumstances that concerns the caller?"),
      askText("Who is present with the patient now?"),
    ],
  },
  {
    key: "psychosocial_crisis",
    label: "Family / caregiver psychological crisis",
    snomed: SNOMED_UNSPECIFIED,
    discipline: "msw",
    questions: [
      askText("What is the caller describing?"),
      askYesIsFlag("Is anyone in the home at risk of harm right now?"),
      askYesNo("Is the caller able to stay with the patient safely tonight?"),
      askYesNo("Has the family been offered the after-hours MSW or chaplain?"),
    ],
  },
  {
    key: "suicidal_ideation",
    label: "Suicidal ideation",
    snomed: "6471006",
    discipline: "clinical_rn",
    mandatoryTier: "tier_3_medical_director",
    questions: [
      askYesIsFlag("Is the patient expressing intent to end their life?"),
      askYesIsFlag("Has the patient named a plan or a means?"),
      askYesIsFlag("Are lethal means (firearms, stockpiled medication) accessible in the home?"),
      askYesNo("Is someone able to stay with the patient right now?"),
    ],
  },
  {
    key: "suspected_abuse_neglect",
    label: "Suspected abuse or neglect",
    snomed: SNOMED_UNSPECIFIED,
    discipline: "clinical_rn",
    mandatoryTier: "tier_4_compliance_officer",
    questions: [
      askYesIsFlag("Is there a concern of abuse, neglect or exploitation?"),
      askText("What was observed or reported, in the reporter's own words?"),
      askYesIsFlag("Is the patient in immediate danger?"),
      askYesNo("Has the patient been asked, privately, whether they feel safe?"),
    ],
  },
  {
    key: "medication_question",
    label: "Medication question (refill, side effect, interaction)",
    snomed: SNOMED_UNSPECIFIED,
    discipline: "clinical_lpn",
    questions: [
      ask("What kind of medication question is this?", "enum", {
        enumValues: ["refill", "side_effect", "interaction", "dose_clarification", "other"],
      }),
      askYesIsFlag("Will the patient run out of a comfort medication before the next delivery?"),
      askText("Which medication, and what is being asked?"),
      askYesNo("Has the caregiver been shown the current medication list?"),
    ],
  },
  {
    key: "comfort_kit_access_question",
    label: "Comfort-kit access question",
    snomed: SNOMED_UNSPECIFIED,
    discipline: "clinical_lpn",
    questions: [
      askYesNo("Is the comfort kit physically in the home?"),
      askYesNo("Can the caregiver access the lock box?"),
      askYesIsFlag("Is a comfort-kit medication missing or past its expiration date?"),
      askText("What does the caregiver need from the kit tonight?"),
    ],
  },
  {
    key: "emergency_drug_request_unfulfillable",
    label: "Emergency medication need not fulfillable from the comfort kit",
    snomed: SNOMED_UNSPECIFIED,
    discipline: "clinical_rn",
    mandatoryTier: "tier_3_medical_director",
    questions: [
      askText("What medication is needed, and for which symptom?"),
      askYesIsFlag("Is the needed medication absent from the comfort kit?"),
      askYesIsFlag("Is the symptom uncontrolled while the medication is unavailable?"),
      askText("Which pharmacy options have already been tried tonight?"),
    ],
  },
  {
    key: "dme_malfunction",
    label: "DME malfunction (oxygen, bed, BiPAP)",
    snomed: SNOMED_UNSPECIFIED,
    discipline: "clinical_lpn",
    questions: [
      ask("Which equipment is affected?", "enum", {
        enumValues: ["oxygen_concentrator", "hospital_bed", "bipap", "suction", "other"],
      }),
      askYesIsFlag("Is the patient dependent on this equipment right now?"),
      askYesNo("Is a backup available in the home (e.g. an E-tank)?"),
      askText("What is the equipment doing or failing to do?"),
    ],
  },
  {
    key: "wound_deterioration",
    label: "Wound deterioration",
    snomed: SNOMED_UNSPECIFIED,
    discipline: "clinical_lpn",
    questions: [
      askText("Which wound, and what has changed?"),
      askYesIsFlag("Is there new bleeding, odour, or drainage soaking through?"),
      askScaleAtLeast("Pain at the wound site 0–10?", 7),
      askYesNo("Are dressing supplies available in the home tonight?"),
    ],
  },
  {
    key: "iv_pump_alarm",
    label: "IV / infusion pump alarm",
    snomed: SNOMED_UNSPECIFIED,
    discipline: "clinical_rn",
    questions: [
      askText("What does the pump display say?"),
      askYesIsFlag("Has the infusion stopped delivering?"),
      askYesIsFlag("Is the site red, swollen or painful?"),
      askYesNo("Has the caregiver been talked through silencing the alarm safely?"),
    ],
  },
  {
    key: "other_clinical_concern",
    label: "Other clinical concern",
    snomed: SNOMED_UNSPECIFIED,
    discipline: "clinical_lpn",
    questions: [
      // §1.1 — the catch-all "requires the on-call RN to free-text-document the situation and select an
      // escalation tier". The free text is required; the tier is chosen through the escalate command
      // (which carries `triage.escalate`), not encoded as an answer nobody would be permissioned for.
      askText("Describe the situation the caller is reporting."),
      askYesIsFlag("Is anything about this call time-critical?"),
      askYesNo("Has the patient's plan of care been reviewed for guidance on this symptom?"),
    ],
  },
];

/** §3.2 Phase E — the platform floor, materialized. Ids and question ids are deterministic so the seed can
 *  be re-run (`ON CONFLICT DO NOTHING`) and so a later migration can amend one row by id. */
export const PLATFORM_FLOOR_PROTOCOLS: readonly CatalogProtocol[] = SPECS.map((spec, index) => {
  const n = index + 1;
  return {
    id: protocolId(n),
    key: spec.key,
    chiefComplaintLabel: spec.label,
    snomedCode: spec.snomed,
    disciplineRequired: spec.discipline,
    requiresMandatoryEscalation: spec.mandatoryTier !== undefined,
    mandatoryEscalationTier: spec.mandatoryTier ?? null,
    sortOrder: n * 10,
    questions: spec.questions.map((build, qIndex) => build(n, qIndex + 1)),
  };
});

/** D7 — the four protocols no tenant configuration can disarm (§1.1). Exported so the §9 tests assert the
 *  set by NAME rather than by counting flags: a floor row that lost its flag would still pass a count. */
export const MANDATORY_ESCALATION_PROTOCOL_KEYS = [
  "unresponsive_patient",
  "suicidal_ideation",
  "suspected_abuse_neglect",
  "emergency_drug_request_unfulfillable",
] as const;

/** Look one floor protocol up by its catalog key. */
export function floorProtocolByKey(key: string): CatalogProtocol | undefined {
  return PLATFORM_FLOOR_PROTOCOLS.find((p) => p.key === key);
}

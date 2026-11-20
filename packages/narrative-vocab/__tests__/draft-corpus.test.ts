// packages/narrative-vocab/__tests__/draft-corpus.test.ts — the visit-note draft phrases (S1 PR B, VN-D14/VN-D15).
// The corpus is DRAFT wording until the named clinical reviewer approves it; these tests pin the release
// bookkeeping, the review gate constant, the scoping of the new entries, and their exact wording.
import { ENCOUNTER_DISCIPLINE_RULES, type EncounterType } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  CORPUS_CLINICAL_REVIEW,
  DRAFT_VOCAB_CODES,
  NARRATIVE_VOCAB_RELEASES,
  VOCABULARY,
  VOCAB_VERSION,
  activeNarrativeVocabRelease,
  effectiveReviewStatus,
  entriesFor,
  getVocabEntry,
} from "../src/index";

const LEGACY_ENTRY_COUNT = 23;
const ROUTINE_ENTRY_COUNT = 25; // narrative-vocab@2026.11.0 (S1)
const RECERT_ENTRY_COUNT = 11; // narrative-vocab@2026.12.0 (S2)
const ADMISSION_ENTRY_COUNT = 5; // narrative-vocab@2026.12.1 (S2b)
const DRAFT_ENTRY_COUNT = ROUTINE_ENTRY_COUNT + RECERT_ENTRY_COUNT + ADMISSION_ENTRY_COUNT;
const LEGACY_CODES = new Set(VOCABULARY.slice(0, LEGACY_ENTRY_COUNT).map((e) => e.code));
/** Every draft-wording entry: the 25 of 2026.11.0, the 11 of 2026.12.0 and the 5 of 2026.12.1. The `visit_reason` entries of 2026.11.1 sit after them. */
const NEW_ENTRIES = VOCABULARY.slice(LEGACY_ENTRY_COUNT, LEGACY_ENTRY_COUNT + DRAFT_ENTRY_COUNT);
const ROUTINE_ENTRIES = NEW_ENTRIES.slice(0, ROUTINE_ENTRY_COUNT);
const RECERT_ENTRIES = NEW_ENTRIES.slice(
  ROUTINE_ENTRY_COUNT,
  ROUTINE_ENTRY_COUNT + RECERT_ENTRY_COUNT,
);
const ADMISSION_ENTRIES = NEW_ENTRIES.slice(ROUTINE_ENTRY_COUNT + RECERT_ENTRY_COUNT);
/** The S1 entries the recertification visit drafts from too (S2 tags them for it; their wording is pinned below). */
const SHARED_WITH_RECERT = new Set([
  ...["pps_first", "pps_down", "pps_up", "pps_same"].map((s) => `nv.scale.${s}`),
  ...["esas_first", "esas_down", "esas_up", "esas_same"].map((s) => `nv.scale.${s}`),
  ...["bp", "hr", "rr", "temp", "spo2", "pain"].map((s) => `nv.vit.${s}`),
  ...["goal_progress", "goal_listed", "intervention_performed"].map((s) => `nv.cp.${s}`),
  ...["started", "changed", "discontinued"].map((s) => `nv.med.${s}`),
]);
/** Of those, the ones the RN admission visit drafts from too (S2b tags them for it): everything but the PPS phrases. */
const SHARED_WITH_ADMISSION = new Set(
  [...SHARED_WITH_RECERT].filter((code) => !code.startsWith("nv.scale.pps_")),
);

describe("corpus release", () => {
  it("is a new release, registered with its own uuid and a date", () => {
    expect(VOCAB_VERSION).toBe("narrative-vocab@2026.12.1");
    expect(NARRATIVE_VOCAB_RELEASES.map((r) => r.version)).toEqual([
      "narrative-vocab@2026.06.0",
      "narrative-vocab@2026.11.0",
      "narrative-vocab@2026.11.1",
      "narrative-vocab@2026.12.0",
      "narrative-vocab@2026.12.1",
    ]);
    expect(activeNarrativeVocabRelease(VOCAB_VERSION).version).toBe(VOCAB_VERSION);
    expect(activeNarrativeVocabRelease(VOCAB_VERSION).releasedOn).toBe("2026-11-21");
  });

  it("keeps the 2026.12.0 release row untouched (a note signed under it pins that id)", () => {
    expect(NARRATIVE_VOCAB_RELEASES[3]).toEqual({
      version: "narrative-vocab@2026.12.0",
      id: "5ea65aa0-a1c6-4e27-8853-825abfcb5240",
      releasedOn: "2026-11-20",
    });
  });

  it("keeps the 2026.11.0 release row untouched (a note signed under it pins that id)", () => {
    expect(NARRATIVE_VOCAB_RELEASES[1]).toEqual({
      version: "narrative-vocab@2026.11.0",
      id: "0e92f042-d45f-426c-918a-d3391387dd69",
      releasedOn: "2026-11-18",
    });
  });

  it("keeps the 2026.06.0 release row untouched (a signed note pins that id)", () => {
    expect(NARRATIVE_VOCAB_RELEASES[0]).toEqual({
      version: "narrative-vocab@2026.06.0",
      id: "81dcb265-d2ef-456b-b029-1bcce25105e7",
      releasedOn: "2026-06-01",
    });
  });
});

describe("CORPUS_CLINICAL_REVIEW", () => {
  it("names ADA and is pending until the reviewer approves the draft wording", () => {
    expect(CORPUS_CLINICAL_REVIEW).toEqual({
      reviewer: "ADA",
      status: "pending",
      reviewedVersion: null,
    });
  });

  it("is typed so a later gate can compare against both states", () => {
    const status: "pending" | "approved" = CORPUS_CLINICAL_REVIEW.status;
    expect(["pending", "approved"]).toContain(status);
  });

  // The approval is of one corpus release (S2 design, VN-D14): a release cut after it is unreviewed wording. Whoever bumps
  // `VOCAB_VERSION` must settle the review in the same commit (ADA approves the new release, or the constant goes back to pending).
  // Going back to pending does not switch off a tenant that is already on; the owner decides that separately.
  it("an approval names the running corpus release, or the release was cut after the review", () => {
    if (CORPUS_CLINICAL_REVIEW.status === "pending") {
      expect(CORPUS_CLINICAL_REVIEW.reviewedVersion).toBeNull();
    } else {
      expect(CORPUS_CLINICAL_REVIEW.reviewedVersion).toBe(VOCAB_VERSION);
    }
  });
});

describe("effectiveReviewStatus", () => {
  const approvedFor = (reviewedVersion: string | null) => ({
    reviewer: "ADA" as const,
    status: "approved" as const,
    reviewedVersion,
  });

  it("is approved only when the approval names the release asked about", () => {
    expect(effectiveReviewStatus(approvedFor(VOCAB_VERSION))).toBe("approved");
    expect(effectiveReviewStatus(approvedFor("narrative-vocab@2026.06.0"))).toBe("pending");
    expect(
      effectiveReviewStatus(approvedFor("narrative-vocab@2099.01.0"), "narrative-vocab@2099.01.0"),
    ).toBe("approved");
  });

  it("fails closed: an approval that names no release, or a pending review, is pending", () => {
    expect(effectiveReviewStatus(approvedFor(null))).toBe("pending");
    expect(
      effectiveReviewStatus({ reviewer: "ADA", status: "pending", reviewedVersion: null }),
    ).toBe("pending");
    expect(
      effectiveReviewStatus({
        reviewer: "ADA",
        status: "pending",
        reviewedVersion: VOCAB_VERSION,
      }),
    ).toBe("pending");
  });
});

describe("DRAFT_VOCAB_CODES", () => {
  it("is exactly the codes added in 2026.11.0, 2026.12.0 and 2026.12.1, none of the 23 earlier ones", () => {
    expect([...DRAFT_VOCAB_CODES].sort()).toEqual(NEW_ENTRIES.map((e) => e.code).sort());
    for (const code of LEGACY_CODES) expect(DRAFT_VOCAB_CODES.has(code)).toBe(false);
  });
});

describe("draft entries", () => {
  it("adds 25 entries (2026.11.0), then 11 (2026.12.0), then 5 (2026.12.1) after the 23 legacy ones, with unique codes", () => {
    expect(ROUTINE_ENTRIES).toHaveLength(ROUTINE_ENTRY_COUNT);
    expect(RECERT_ENTRIES).toHaveLength(RECERT_ENTRY_COUNT);
    expect(ADMISSION_ENTRIES).toHaveLength(ADMISSION_ENTRY_COUNT);
    expect(new Set(VOCABULARY.map((e) => e.code)).size).toBe(VOCABULARY.length);
    for (const e of NEW_ENTRIES) expect(LEGACY_CODES.has(e.code)).toBe(false);
  });

  it("the 25 of 2026.11.0 are tagged for the RN routine visit, 20 of them also for the recertification visit and 16 also for the admission visit", () => {
    for (const e of ROUTINE_ENTRIES) {
      expect(e.disciplines, e.code).toEqual(["rn"]);
      expect(e.encounterTypes, e.code).toEqual(
        SHARED_WITH_ADMISSION.has(e.code)
          ? ["routine_visit", "recert_visit", "admission_visit"]
          : SHARED_WITH_RECERT.has(e.code)
            ? ["routine_visit", "recert_visit"]
            : ["routine_visit"],
      );
    }
    expect(ROUTINE_ENTRIES.filter((e) => SHARED_WITH_RECERT.has(e.code))).toHaveLength(20);
    expect(ROUTINE_ENTRIES.filter((e) => SHARED_WITH_ADMISSION.has(e.code))).toHaveLength(16);
  });

  it("the 5 of 2026.12.1 are tagged for the RN admission visit alone, in one draft-only category", () => {
    for (const e of ADMISSION_ENTRIES) {
      expect(e.disciplines, e.code).toEqual(["rn"]);
      expect(e.encounterTypes, e.code).toEqual(["admission_visit"]);
      expect(e.category, e.code).toBe("admission_record");
      expect(e.code.startsWith("nv.adm."), e.code).toBe(true);
    }
  });

  it("the 11 of 2026.12.0 are tagged for the recertification visit, and 7 of them also for the face-to-face visit", () => {
    const f2fToo = RECERT_ENTRIES.filter((e) => e.encounterTypes.includes("face_to_face"));
    expect(f2fToo.map((e) => e.code).sort()).toEqual([
      "nv.rc.pps_baseline_down",
      "nv.rc.pps_baseline_same",
      "nv.rc.pps_baseline_up",
      "nv.rc.weight_down",
      "nv.rc.weight_first",
      "nv.rc.weight_same",
      "nv.rc.weight_up",
    ]);
    for (const e of f2fToo) {
      expect(e.disciplines, e.code).toEqual(["rn", "md", "np"]);
      expect(e.encounterTypes, e.code).toEqual(["recert_visit", "face_to_face"]);
    }
    for (const e of RECERT_ENTRIES.filter((x) => !f2fToo.includes(x))) {
      expect(e.disciplines, e.code).toEqual(["rn"]);
      expect(e.encounterTypes, e.code).toEqual(["recert_visit"]);
    }
  });

  it("surface in no other legal (encounter type x discipline) menu than the templates that draft", () => {
    const drafting = new Set([
      "routine_visit:rn",
      "recert_visit:rn",
      "admission_visit:rn",
      "face_to_face:md",
      "face_to_face:np",
    ]);
    for (const type of Object.keys(ENCOUNTER_DISCIPLINE_RULES) as EncounterType[]) {
      for (const discipline of ENCOUNTER_DISCIPLINE_RULES[type]) {
        if (drafting.has(`${type}:${discipline}`)) continue;
        const surfaced = entriesFor(type, discipline).filter((e) => DRAFT_VOCAB_CODES.has(e.code));
        expect(surfaced, `${type}:${discipline}`).toEqual([]);
      }
    }
  });

  it("surface in the menus of the templates that draft, and only the entries tagged for each", () => {
    const codes = (type: EncounterType, discipline: "rn" | "md" | "np"): string[] =>
      entriesFor(type, discipline)
        .filter((e) => DRAFT_VOCAB_CODES.has(e.code))
        .map((e) => e.code);
    expect(codes("routine_visit", "rn").sort()).toEqual(ROUTINE_ENTRIES.map((e) => e.code).sort());
    expect(codes("recert_visit", "rn").sort()).toEqual(
      [...SHARED_WITH_RECERT, ...RECERT_ENTRIES.map((e) => e.code)].sort(),
    );
    expect(codes("admission_visit", "rn").sort()).toEqual(
      [...SHARED_WITH_ADMISSION, ...ADMISSION_ENTRIES.map((e) => e.code)].sort(),
    );
    for (const discipline of ["md", "np"] as const) {
      expect(codes("face_to_face", discipline).sort()).toEqual(
        RECERT_ENTRIES.filter((e) => e.encounterTypes.includes("face_to_face"))
          .map((e) => e.code)
          .sort(),
      );
    }
  });

  it("use only the categories the draft needs", () => {
    const categories = [...new Set(NEW_ENTRIES.map((e) => e.category))].sort();
    expect(categories).toEqual([
      "admission_record",
      "benefit_period",
      "care_plan_element",
      "chief_concern",
      "decline_evidence",
      "medication_change",
      "plan",
      "scale_reading",
      "vitals_review",
    ]);
  });

  it("slot names do not collide with the context slots the assembler always supplies", () => {
    for (const e of NEW_ENTRIES) {
      const slots = [...e.phrase.matchAll(/\$\{([A-Za-z0-9_.]+)\}/g)].map((m) => m[1]);
      for (const slot of slots) expect(["patient", "serviceDate", "location"]).not.toContain(slot);
    }
  });
});

describe("draft wording (neutral, factual, numbers only)", () => {
  const wording: ReadonlyArray<readonly [string, string]> = [
    ["nv.scale.pps_first", "PPS ${pps_value}%, no earlier reading recorded"],
    [
      "nv.scale.pps_down",
      "PPS ${pps_value}%, down from ${pps_previous_value}% on ${pps_previous_date}",
    ],
    [
      "nv.scale.pps_up",
      "PPS ${pps_value}%, up from ${pps_previous_value}% on ${pps_previous_date}",
    ],
    [
      "nv.scale.pps_same",
      "PPS ${pps_value}%, unchanged from ${pps_previous_value}% on ${pps_previous_date}",
    ],
    ["nv.scale.esas_first", "ESAS-r ${esas_label} ${esas_value}, no earlier reading recorded"],
    [
      "nv.scale.esas_down",
      "ESAS-r ${esas_label} ${esas_value}, down from ${esas_previous_value} on ${esas_previous_date}",
    ],
    [
      "nv.scale.esas_up",
      "ESAS-r ${esas_label} ${esas_value}, up from ${esas_previous_value} on ${esas_previous_date}",
    ],
    [
      "nv.scale.esas_same",
      "ESAS-r ${esas_label} ${esas_value}, unchanged from ${esas_previous_value} on ${esas_previous_date}",
    ],
    ["nv.vit.reviewed", "Vital signs for this visit were reviewed"],
    ["nv.vit.bp", "Blood pressure ${bp_systolic}/${bp_diastolic} mmHg"],
    ["nv.vit.hr", "Heart rate ${heart_rate} beats per minute"],
    ["nv.vit.rr", "Respiratory rate ${respiratory_rate} breaths per minute"],
    ["nv.vit.temp", "Temperature ${temperature} degrees ${temperature_unit}"],
    ["nv.vit.spo2", "Oxygen saturation ${spo2}%"],
    ["nv.vit.pain", "Pain score ${pain_score} of 10"],
    ["nv.cp.goal_progress", "Care-plan goal: ${goal_text}; progress: ${progress_statement}"],
    ["nv.cp.goal_listed", "Care-plan goal: ${goal_text}"],
    ["nv.cp.intervention_performed", "Care-plan intervention performed: ${intervention_text}"],
    ["nv.med.started", "${drug_name} was started on ${change_date}"],
    ["nv.med.changed", "${drug_name} order was changed on ${change_date}"],
    ["nv.med.discontinued", "${drug_name} was discontinued on ${change_date}"],
    ["nv.cc.routine_visit", "Routine scheduled visit per the plan of care"],
    ["nv.cc.follow_up", "Visit to follow up on ${follow_up_topic}"],
    ["nv.plan.continue", "The current plan of care continues"],
    ["nv.plan.next_visit", "Next visit is planned for ${next_visit_date}"],
  ];

  it("pins every 2026.11.0 phrase byte for byte (S2 only adds a tag to 20 of them)", () => {
    expect(wording).toHaveLength(ROUTINE_ENTRY_COUNT);
    for (const [code, phrase] of wording) expect(getVocabEntry(code)?.phrase, code).toBe(phrase);
  });

  // S2 (VN-D32): numbers, dates and the names of recorded facts; no prognosis, eligibility conclusion or life expectancy.
  const recertWording: ReadonlyArray<readonly [string, string]> = [
    [
      "nv.rc.pps_baseline_down",
      "PPS ${pps_value}%, down from ${pps_baseline_value}% on ${pps_baseline_date}, the first reading of this benefit period",
    ],
    [
      "nv.rc.pps_baseline_up",
      "PPS ${pps_value}%, up from ${pps_baseline_value}% on ${pps_baseline_date}, the first reading of this benefit period",
    ],
    [
      "nv.rc.pps_baseline_same",
      "PPS ${pps_value}%, unchanged from ${pps_baseline_value}% on ${pps_baseline_date}, the first reading of this benefit period",
    ],
    [
      "nv.rc.weight_first",
      "Weight ${weight_value} ${weight_unit} on ${weight_date}, the only weight recorded in this benefit period",
    ],
    [
      "nv.rc.weight_down",
      "Weight ${weight_value} ${weight_unit} on ${weight_date}, down ${weight_change_percent}% from ${weight_baseline_value} ${weight_unit} on ${weight_baseline_date}",
    ],
    [
      "nv.rc.weight_up",
      "Weight ${weight_value} ${weight_unit} on ${weight_date}, up ${weight_change_percent}% from ${weight_baseline_value} ${weight_unit} on ${weight_baseline_date}",
    ],
    [
      "nv.rc.weight_same",
      "Weight ${weight_value} ${weight_unit} on ${weight_date}, unchanged from ${weight_baseline_value} ${weight_unit} on ${weight_baseline_date}",
    ],
    [
      "nv.rc.f2f",
      "Face-to-face encounter performed by a hospice ${f2f_performer} on ${f2f_performed_on}, attested on ${f2f_attested_on}",
    ],
    [
      "nv.rc.period",
      "Benefit period ${period_sequence}, ${period_length}-day period from ${period_start} to ${period_end}; day ${period_day} on the date of this visit",
    ],
    ["nv.rc.level_of_care", "Level of care on the date of this visit: ${level_of_care}"],
    [
      "nv.rc.cti_signed",
      "Certification of terminal illness for this benefit period signed on ${cti_signed_on}",
    ],
  ];

  it("pins every 2026.12.0 phrase byte for byte", () => {
    expect(recertWording).toHaveLength(RECERT_ENTRY_COUNT);
    for (const [code, phrase] of recertWording) {
      expect(getVocabEntry(code)?.phrase, code).toBe(phrase);
    }
  });

  // S2b (VN-D35): a fact that is on record, never "reconciled", never a directive the patient has or lacks, never an absence.
  const admissionWording: ReadonlyArray<readonly [string, string]> = [
    [
      "nv.adm.med_active",
      "Active order at the visit: ${drug_name} ${strength} ${dose_form}, ${route}",
    ],
    [
      "nv.adm.med_active_prn",
      "Active order at the visit, as needed: ${drug_name} ${strength} ${dose_form}, ${route}",
    ],
    [
      "nv.adm.ad_ack_on_file",
      "An advance directive acknowledgment was on file at the time of the visit",
    ],
    [
      "nv.adm.caregiver_primary",
      "${caregiver_name} (${caregiver_relationship}) is recorded as the primary caregiver",
    ],
    [
      "nv.adm.caregiver_other",
      "${caregiver_name} (${caregiver_relationship}) is recorded as a caregiver",
    ],
  ];

  it("pins every 2026.12.1 phrase byte for byte", () => {
    expect(admissionWording).toHaveLength(ADMISSION_ENTRY_COUNT);
    for (const [code, phrase] of admissionWording) {
      expect(getVocabEntry(code)?.phrase, code).toBe(phrase);
    }
  });

  it("no 2026.12.1 phrase says a medication was reconciled or verified, that the patient has or lacks a directive, or that nothing is on file", () => {
    for (const [code, phrase] of admissionWording) {
      const text = phrase.toLowerCase();
      for (const word of [
        "reconcil",
        "verified",
        "complete",
        "no ",
        "none",
        "not on file",
        "has an advance",
        "code status",
        "dnr",
        "full code",
      ]) {
        expect(text, code).not.toContain(word);
      }
    }
  });

  it("no 2026.12.0 phrase states a prognosis, an eligibility conclusion or a life expectancy", () => {
    for (const [code, phrase] of recertWording) {
      // The certification's own name is the one place the word "terminal" appears: it names a signed document.
      const text = phrase.toLowerCase().replace("certification of terminal illness", "");
      for (const word of ["terminal", "eligib", "months", "life expectancy", "qualif", "prognos"]) {
        expect(text, code).not.toContain(word);
      }
    }
  });
});

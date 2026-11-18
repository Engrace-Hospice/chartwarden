import {
  type EncounterDiscipline,
  type VisitPurpose,
  isValidEncounterDisciplinePair,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  type SchedulingDiscipline,
  VISIT_PURPOSE_DISCIPLINES,
  encounterTypeForVisit,
  selectVisitAssignmentDiscipline,
} from "../src/policy";

describe("HOPE scheduling purposes", () => {
  it("matches the M10 author-discipline floors without completing an assessment", () => {
    expect(VISIT_PURPOSE_DISCIPLINES.huv1).toEqual(["rn", "np", "md"]);
    expect(VISIT_PURPOSE_DISCIPLINES.huv2).toEqual(["rn", "np", "md"]);
    expect(VISIT_PURPOSE_DISCIPLINES.sfv).toEqual(["rn", "np", "lpn"]);
  });

  it("stamps the discipline the selected clinician actually qualifies under", () => {
    expect(selectVisitAssignmentDiscipline("huv1", ["np"], ["np"])).toBe("np");
    expect(selectVisitAssignmentDiscipline("sfv", ["lpn"], ["lpn"])).toBe("lpn");
    expect(selectVisitAssignmentDiscipline("huv2", ["rn", "np"], ["np"])).toBe("np");
  });

  it("prefers a discipline with a legal M8 pair over an earlier one without", () => {
    // sfv lists rn, np, lpn: a clinician holding np and lpn (no rn) is stamped lpn, not refused as np.
    expect(selectVisitAssignmentDiscipline("sfv", ["np", "lpn"], ["np", "lpn"])).toBe("lpn");
    // With no legal alternative the unpairable discipline is still selected, so the stamping gate
    // refuses it with its own VISIT_ENCOUNTER_TYPE_UNSUPPORTED code rather than a generic gate miss.
    expect(selectVisitAssignmentDiscipline("sfv", ["np"], ["np"])).toBe("np");
  });
});

// M8 spec §2.2 / §2.7: a visit's (encounter type, discipline) must be a legal pair, because the M8
// `m17.visit.published` consumer seeds a draft encounter from it. M8 §2.2 defines no HUV1/HUV2/SFV
// encounter type; RN/LPN fall to `routine_visit` (legal), NP/MD have no legal type and are refused.
describe("scheduled visit -> encounter type (M8 §2.2 / §2.7 legal pairs)", () => {
  const UNSUPPORTED: Partial<Record<VisitPurpose, readonly SchedulingDiscipline[]>> = {
    pronouncement: ["md", "np"],
    huv1: ["np", "md"],
    huv2: ["np", "md"],
    sfv: ["np"],
  };

  it("maps every policy-allowed (purpose, discipline) to a legal M8 pair or to null, never an illegal pair", () => {
    for (const purpose of Object.keys(VISIT_PURPOSE_DISCIPLINES) as VisitPurpose[]) {
      for (const discipline of VISIT_PURPOSE_DISCIPLINES[purpose]) {
        const type = encounterTypeForVisit(purpose, discipline);
        const expectedUnsupported = UNSUPPORTED[purpose]?.includes(discipline) ?? false;
        expect(type === null, `${purpose}/${discipline}`).toBe(expectedUnsupported);
        if (type !== null) {
          expect(
            isValidEncounterDisciplinePair(type, discipline as EncounterDiscipline),
            `${purpose}/${discipline} -> ${type}`,
          ).toBe(true);
        }
      }
    }
  });

  // A purpose whose every allowed discipline has no legal M8 pair is refused (422
  // VISIT_ENCOUNTER_TYPE_UNSUPPORTED) for every clinician: a dead end. M17 used to require md/np for
  // `recert` and `loc_change` while M8 §2.2 gives `recert_visit` to RN (a kickoff visit, "not the F2F
  // itself") and seeds `loc_change` as routine_visit (RN/LPN), so both were dead ends. This ratchet keeps
  // the list empty: a new purpose or discipline edit that creates a dead end fails here.
  it("leaves no purpose unschedulable: every purpose has at least one discipline with a legal M8 pair", () => {
    const unschedulable = (Object.keys(VISIT_PURPOSE_DISCIPLINES) as VisitPurpose[])
      .filter((purpose) =>
        VISIT_PURPOSE_DISCIPLINES[purpose].every(
          (discipline) => encounterTypeForVisit(purpose, discipline) === null,
        ),
      )
      .sort();
    expect(unschedulable).toEqual([]);
  });

  it("schedules recert and loc_change for an RN only (M8: recert_visit is RN; loc_change seeds routine_visit)", () => {
    expect(VISIT_PURPOSE_DISCIPLINES.recert).toEqual(["rn"]);
    expect(VISIT_PURPOSE_DISCIPLINES.loc_change).toEqual(["rn"]);
    expect(encounterTypeForVisit("recert", "rn")).toBe("recert_visit");
    expect(encounterTypeForVisit("loc_change", "rn")).toBe("routine_visit");
    // The physician or NP encounter of a recertification is the f2f purpose, not recert.
    expect(selectVisitAssignmentDiscipline("recert", ["md", "np"], ["md", "np"])).toBeNull();
    expect(selectVisitAssignmentDiscipline("loc_change", ["md", "np"], ["md", "np"])).toBeNull();
    expect(selectVisitAssignmentDiscipline("recert", ["rn", "np"], ["rn", "np"])).toBe("rn");
  });

  it("keeps RN and LPN HUV/SFV visits on routine_visit (the only legal HUV-capable type)", () => {
    expect(encounterTypeForVisit("huv1", "rn")).toBe("routine_visit");
    expect(encounterTypeForVisit("huv2", "rn")).toBe("routine_visit");
    expect(encounterTypeForVisit("sfv", "rn")).toBe("routine_visit");
    expect(encounterTypeForVisit("sfv", "lpn")).toBe("routine_visit");
  });

  it("keeps the discipline-named and F2F mappings", () => {
    expect(encounterTypeForVisit("f2f", "np")).toBe("face_to_face");
    expect(encounterTypeForVisit("aide_poc", "chha")).toBe("chha_visit");
    expect(encounterTypeForVisit("recert", "rn")).toBe("recert_visit");
    expect(encounterTypeForVisit("admission_visit", "rn")).toBe("admission_visit");
  });

  it("returns null for an illegal (encounter type, discipline) pair", () => {
    expect(encounterTypeForVisit("routine_visit", "np")).toBeNull();
  });
});

// apps/backend/__tests__/wounds-value-set-parity.test.ts — the wound value sets M9 stores must equal the ones the
// visit note (@chartwarden/hearthnote `RecordedWound`) states. M9 may not import the note package, so it keeps a copy;
// this test is the only place both are read, and it fails when either moves alone.
import {
  EXUDATE_AMOUNTS as M9_EXUDATE_AMOUNTS,
  EXUDATE_TYPES as M9_EXUDATE_TYPES,
  PERIWOUND_CONDITIONS as M9_PERIWOUND_CONDITIONS,
  PRESSURE_STAGES as M9_PRESSURE_STAGES,
  WOUND_BED_TISSUES as M9_WOUND_BED_TISSUES,
  WOUND_DRESSINGS as M9_WOUND_DRESSINGS,
  WOUND_ETIOLOGIES as M9_WOUND_ETIOLOGIES,
  WOUND_ODORS as M9_WOUND_ODORS,
  WOUND_TRENDS as M9_WOUND_TRENDS,
  type WoundObservationView,
} from "@chartwarden/assessments";
import {
  EXUDATE_AMOUNTS,
  EXUDATE_TYPES,
  PERIWOUND_CONDITIONS,
  PRESSURE_STAGES,
  type RecordedWound,
  WOUND_BED_TISSUES,
  WOUND_DRESSINGS,
  WOUND_ETIOLOGIES,
  WOUND_ODORS,
  WOUND_TRENDS,
} from "@chartwarden/hearthnote";
import { describe, expect, it } from "vitest";

describe("M9 wound value sets equal the note contract", () => {
  it.each([
    ["WOUND_ETIOLOGIES", M9_WOUND_ETIOLOGIES, WOUND_ETIOLOGIES],
    ["PRESSURE_STAGES", M9_PRESSURE_STAGES, PRESSURE_STAGES],
    ["WOUND_BED_TISSUES", M9_WOUND_BED_TISSUES, WOUND_BED_TISSUES],
    ["EXUDATE_AMOUNTS", M9_EXUDATE_AMOUNTS, EXUDATE_AMOUNTS],
    ["EXUDATE_TYPES", M9_EXUDATE_TYPES, EXUDATE_TYPES],
    ["WOUND_ODORS", M9_WOUND_ODORS, WOUND_ODORS],
    ["PERIWOUND_CONDITIONS", M9_PERIWOUND_CONDITIONS, PERIWOUND_CONDITIONS],
    ["WOUND_DRESSINGS", M9_WOUND_DRESSINGS, WOUND_DRESSINGS],
    ["WOUND_TRENDS", M9_WOUND_TRENDS, WOUND_TRENDS],
  ] as const)("%s", (_name, m9, note) => {
    // Assert: same values in the same order (the order is the order screens list them in)
    expect([...m9]).toEqual([...note]);
  });
});

/** Compile-time pin (checked by `typecheck:tests`): what the seam returns IS what the note states. */
const asRecordedWound = (view: WoundObservationView): RecordedWound => view;

describe("the seam view is a RecordedWound", () => {
  it("states the same site, etiology and findings the note renders", () => {
    // Arrange
    const view: WoundObservationView = {
      observationId: "o1",
      woundId: "w1",
      observedAt: "2026-11-19T14:00:00.000Z",
      site: "left heel",
      etiology: "pressure_injury",
      stage: "stage_2",
      lengthCm: 3,
      widthCm: 2,
      depthCm: null,
      undermining: null,
      woundBed: ["granulation"],
      exudateAmount: null,
      exudateType: null,
      odor: null,
      periwound: [],
      painScore: 3,
      dressing: "foam",
      dressingChanged: true,
      infectionSigns: false,
      trend: "new",
    };
    // Act
    const note = asRecordedWound(view);
    // Assert
    expect(note).toMatchObject({
      site: "left heel",
      etiology: "pressure_injury",
      stage: "stage_2",
      woundBed: ["granulation"],
    });
  });
});

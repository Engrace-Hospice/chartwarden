import { CANONICAL_DISCIPLINES } from "@chartwarden/billing";
// Lockstep pins for the SIA / visit-line vocabulary. M23's discipline list, M8's TS mirrors and the Postgres
// enums are four hand-written copies of the same sets; one drifting silently turns a real visit into an
// "unknown discipline" (no line, no SIA) or lets a value through that the database then rejects.
import { schema } from "@chartwarden/db";
import {
  ENCOUNTER_VISIT_MODALITIES,
  type EncounterVisitModality,
  MODALITY_CONFIRMATION_DISCIPLINES,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe("billing / M8 vocabulary lockstep", () => {
  it("CANONICAL_DISCIPLINES equals the encounter_discipline pg enum, as sets", () => {
    expect(sorted(CANONICAL_DISCIPLINES)).toEqual(sorted(schema.encounterDiscipline.enumValues));
  });

  it("the TS EncounterVisitModality list equals the encounter_visit_modality pg enum, as sets", () => {
    expect(sorted(ENCOUNTER_VISIT_MODALITIES)).toEqual(
      sorted(schema.encounterVisitModality.enumValues),
    );
  });

  it("the modality-confirmation disciplines are all real encounter disciplines", () => {
    const known = new Set<string>(schema.encounterDiscipline.enumValues);
    expect(MODALITY_CONFIRMATION_DISCIPLINES.filter((d) => !known.has(d))).toEqual([]);
  });

  it("the billing VisitModality accepts exactly the M8 modalities (compile-time pin + runtime list)", () => {
    // Assignable both ways: a widened/narrowed billing union stops compiling here.
    const fromM8: import("@chartwarden/billing").VisitModality =
      "video" satisfies EncounterVisitModality;
    const toM8: EncounterVisitModality = fromM8;
    expect(toM8).toBe("video");
    expect(ENCOUNTER_VISIT_MODALITIES).toEqual(["in_person", "telephonic", "video"]);
  });
});

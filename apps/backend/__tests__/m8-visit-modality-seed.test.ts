// M8 visit-modality seeding: the draft encounter opens with the modality the M17 visit already implies, as an
// UNCONFIRMED pre-selection. Anything the visit does not say stays null: a modality is never guessed.
import { describe, expect, it } from "vitest";
import { seedModalityFor } from "../src/modules/08-encounters/consumers/seed-modality";

describe("seedModalityFor", () => {
  it.each(["patient_home", "facility", "inpatient_unit"])(
    "seeds in_person from the %s visit setting",
    (visitSetting) => {
      expect(seedModalityFor({ visitSetting })).toBe("in_person");
    },
  );

  it("seeds telephonic from the telephonic visit setting", () => {
    expect(seedModalityFor({ visitSetting: "telephonic" })).toBe("telephonic");
  });

  it("seeds telephonic from a telephonic encounter type even with no visit setting", () => {
    expect(seedModalityFor({ encounterType: "telephonic" })).toBe("telephonic");
  });

  it("keeps the safe side when a telephonic encounter type meets an in-person setting", () => {
    expect(seedModalityFor({ visitSetting: "patient_home", encounterType: "telephonic" })).toBe(
      "telephonic",
    );
  });

  it.each([undefined, null, "", "video", "somewhere_else", 42, {}])(
    "seeds nothing for an unknown or absent visit setting (%s)",
    (visitSetting) => {
      expect(seedModalityFor({ visitSetting })).toBeNull();
    },
  );

  it("seeds nothing for an in-person-looking encounter type alone", () => {
    expect(seedModalityFor({ encounterType: "routine_visit" })).toBeNull();
  });
});

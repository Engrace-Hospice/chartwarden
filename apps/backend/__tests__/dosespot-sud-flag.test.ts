// The Part 2 flag M12's seam hands to every reader of a medication order (the visit-note draft's orders in effect and medication changes, the
// portal summary): the stored flag OR the drug classifier, as M12's own sign path decides (`dosespot-route-service-db`). A row written before the
// column was populated, or with it left false, must not dodge the Part 2 gate on a read.
import { describe, expect, it } from "vitest";
import { sudTreatmentOf } from "../src/modules/12-dosespot/seams/drizzle-store";

describe("sudTreatmentOf (the Part 2 flag of an order a seam read hands out)", () => {
  it("is true when the stored flag is true, whatever the drug", () => {
    expect(sudTreatmentOf({ isSudTreatment: true, drugName: "Morphine Sulfate" })).toBe(true);
  });

  it.each([
    "Buprenorphine and Naloxone",
    "buprenorphine 8 mg sublingual",
    "Naltrexone 50 mg",
    "Disulfiram",
    "Acamprosate",
  ])("is true for %s even when the stored flag says false (a legacy row)", (drugName) => {
    expect(sudTreatmentOf({ isSudTreatment: false, drugName })).toBe(true);
  });

  it("is false only when the flag is false and the drug is not a SUD-treatment drug", () => {
    expect(sudTreatmentOf({ isSudTreatment: false, drugName: "Morphine Sulfate" })).toBe(false);
    expect(sudTreatmentOf({ isSudTreatment: false, drugName: "Lorazepam" })).toBe(false);
  });
});

// S2b — `readDraftInputs` for the RN admission visit (design §3.3, VN-D11, VN-D35 to VN-D38): the orders in effect at the visit time, the
// caregivers on record on the service date, the advance directive acknowledgment that was on file. Synthetic ids and values only.
import { describe, expect, it } from "vitest";
import { readDraftInputs } from "../src/modules/08-encounters/drafting/inputs";
import { AS_OF, encounter, fakePorts, viewer } from "./_encounter-draft-fixtures";

const ADMISSION = encounter({ encounterType: "admission_visit" });
const ROUTINE = encounter({ encounterType: "routine_visit" });

/** An M12 order as the provider returns it; only the fields the draft reads are filled. */
const order = (over: Record<string, unknown> = {}) =>
  ({
    id: "order-1",
    drugName: "Morphine sulfate",
    strength: "20 mg/mL",
    doseForm: "oral solution",
    route: "oral",
    sigStructured: { asNeeded: true },
    isSudTreatment: false,
    ...over,
  }) as never;

/** An M5 roster entry as the reader returns it: it carries contact details the draft must never read. */
const caregiver = (over: Record<string, unknown> = {}) =>
  ({
    caregiverId: "caregiver-1",
    patientCaregiverId: "link-1",
    displayName: "Alex Rivera",
    relationship: "spouse",
    isPrimary: true,
    email: "caregiver@example.test",
    phone: "555-0100",
    preferredLanguageCode: "en",
    ...over,
  }) as never;

const admissionPorts = (over: Parameters<typeof fakePorts>[0] = {}) =>
  fakePorts({
    activeMedicationsAsOf: async () => [order()],
    caregiversOn: async () => [caregiver()],
    advanceDirectiveAcknowledgment: async () => ({ consentRecordId: "consent-ad-1" }),
    ...over,
  });

describe("what the admission visit reads", () => {
  it("reads the orders as of the visit time, the caregivers on the service date and the acknowledgment as of the visit time", async () => {
    const ports = admissionPorts();
    await readDraftInputs(ports, ADMISSION, viewer(), AS_OF);
    expect(ports.activeMedicationsAsOf).toHaveBeenCalledWith(
      ADMISSION.organizationId,
      ADMISSION.patientId,
      AS_OF,
    );
    expect(ports.caregiversOn).toHaveBeenCalledWith(
      ADMISSION.organizationId,
      ADMISSION.patientId,
      "2026-11-18",
    );
    expect(ports.advanceDirectiveAcknowledgment).toHaveBeenCalledWith({
      organizationId: ADMISSION.organizationId,
      patientId: ADMISSION.patientId,
      asOf: AS_OF,
    });
  });

  it("any other visit reads none of it and returns none of the new fields", async () => {
    const ports = admissionPorts();
    const inputs = await readDraftInputs(ports, ROUTINE, viewer(), AS_OF);
    expect(ports.activeMedicationsAsOf).not.toHaveBeenCalled();
    expect(ports.caregiversOn).not.toHaveBeenCalled();
    expect(ports.advanceDirectiveAcknowledgment).not.toHaveBeenCalled();
    expect(inputs).not.toHaveProperty("activeMedications");
    expect(inputs).not.toHaveProperty("caregivers");
    expect(inputs).not.toHaveProperty("advanceDirective");
  });

  it("a source that cannot be read stops the draft instead of drafting short", async () => {
    for (const port of [
      "activeMedicationsAsOf",
      "caregiversOn",
      "advanceDirectiveAcknowledgment",
    ] as const) {
      const ports = admissionPorts({
        [port]: async () => {
          throw new Error("synthetic outage");
        },
      });
      await expect(readDraftInputs(ports, ADMISSION, viewer(), AS_OF), port).rejects.toThrow();
    }
  });
});

describe("the orders in effect", () => {
  it("are the drug, strength, form and route of each order, and whether it is as needed", async () => {
    const inputs = await readDraftInputs(admissionPorts(), ADMISSION, viewer(), AS_OF);
    expect(inputs.activeMedications).toEqual([
      {
        id: "order-1",
        drugName: "Morphine sulfate",
        strength: "20 mg/mL",
        doseForm: "oral solution",
        route: "oral",
        asNeeded: true,
        sudRelated: false,
      },
    ]);
  });

  it("leave a SUD treatment order out for a viewer without Part 2 disclosure, asking the verdict once", async () => {
    const ports = admissionPorts({
      activeMedicationsAsOf: async () => [
        order(),
        order({ id: "order-2", drugName: "Buprenorphine", isSudTreatment: true }),
        order({ id: "order-3", drugName: "Naltrexone", isSudTreatment: true }),
      ],
      part2DisclosureAllowed: async () => false,
    });
    const inputs = await readDraftInputs(ports, ADMISSION, viewer(), AS_OF);
    expect(inputs.activeMedications?.map((m) => m.id)).toEqual(["order-1"]);
    expect(ports.part2DisclosureAllowed).toHaveBeenCalledTimes(1);
  });

  it("show it, marked as Part 2, for a viewer with disclosure", async () => {
    const ports = admissionPorts({
      activeMedicationsAsOf: async () => [
        order(),
        order({ id: "order-2", drugName: "Buprenorphine", isSudTreatment: true }),
      ],
      part2DisclosureAllowed: async () => true,
    });
    const inputs = await readDraftInputs(ports, ADMISSION, viewer(), AS_OF);
    expect(inputs.activeMedications?.map((m) => [m.id, m.sudRelated])).toEqual([
      ["order-1", false],
      ["order-2", true],
    ]);
  });

  it("read a missing SUD flag fail closed: only the literal false is not SUD treatment", async () => {
    const ports = admissionPorts({
      activeMedicationsAsOf: async () => [order({ isSudTreatment: undefined })],
      part2DisclosureAllowed: async () => false,
    });
    const inputs = await readDraftInputs(ports, ADMISSION, viewer(), AS_OF);
    expect(inputs.activeMedications).toEqual([]);
  });

  it("ask no Part 2 verdict when no order could be withheld", async () => {
    const ports = admissionPorts();
    await readDraftInputs(ports, ADMISSION, viewer(), AS_OF);
    expect(ports.part2DisclosureAllowed).not.toHaveBeenCalled();
  });

  it.each([
    ["a blank strength", { strength: "  " }],
    ["a blank dose form", { doseForm: "" }],
    ["a blank route", { route: " " }],
    ["a blank drug name", { drugName: "" }],
    ["an as-needed flag that is not true or false", { sigStructured: { asNeeded: "yes" } }],
    ["no structured sig", { sigStructured: undefined }],
  ])(
    "are not drafted at all when one order has %s: a list with an order missing from it would read as complete",
    async (_name, bad) => {
      const ports = admissionPorts({
        activeMedicationsAsOf: async () => [order(), order({ id: "order-2", ...bad })],
      });
      const inputs = await readDraftInputs(ports, ADMISSION, viewer(), AS_OF);
      expect(inputs.activeMedications).toEqual([]);
    },
  );
});

describe("the caregivers on record", () => {
  it("are the name and relationship of each, primary or not, and no contact detail", async () => {
    const inputs = await readDraftInputs(admissionPorts(), ADMISSION, viewer(), AS_OF);
    expect(inputs.caregivers).toEqual([
      {
        id: "link-1",
        displayName: "Alex Rivera",
        relationship: "spouse",
        isPrimary: true,
        sudRelated: false,
      },
    ]);
    expect(JSON.stringify(inputs)).not.toContain("555-0100");
    expect(JSON.stringify(inputs)).not.toContain("caregiver@example.test");
  });

  it.each([
    ["a relationship it has no word for", { relationship: "neighbor" }],
    ["a blank name", { displayName: "  " }],
  ])("are not drafted at all when one has %s", async (_name, bad) => {
    const ports = admissionPorts({
      caregiversOn: async () => [caregiver(), caregiver({ patientCaregiverId: "link-2", ...bad })],
    });
    const inputs = await readDraftInputs(ports, ADMISSION, viewer(), AS_OF);
    expect(inputs.caregivers).toEqual([]);
  });
});

describe("the advance directive acknowledgment", () => {
  it("is the consent record that was on file, as a source with no content", async () => {
    const inputs = await readDraftInputs(admissionPorts(), ADMISSION, viewer(), AS_OF);
    expect(inputs.advanceDirective).toEqual({ id: "consent-ad-1", sudRelated: false });
  });

  it("is none when no acknowledgment was on file", async () => {
    const ports = admissionPorts({ advanceDirectiveAcknowledgment: async () => null });
    const inputs = await readDraftInputs(ports, ADMISSION, viewer(), AS_OF);
    expect(inputs.advanceDirective).toBeNull();
  });
});

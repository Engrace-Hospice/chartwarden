// S5 — `readDraftInputs` for the face-to-face visit by a physician or nurse practitioner and for the IDG follow-up of every discipline (design §3.7,
// VN-D11, VN-D52 to VN-D54): the recorded vitals, the orders in effect, and for the social worker and the chaplain the discipline's own plan. A visit
// reads only the sources its drafted sections are built from. Synthetic ids and values only.
import { describe, expect, it } from "vitest";
import { readDraftInputs } from "../src/modules/08-encounters/drafting/inputs";
import { AS_OF, encounter, fakePorts, order, viewer } from "./_encounter-draft-fixtures";

const F2F_NP = encounter({ encounterType: "face_to_face", discipline: "np" });
const F2F_MD = encounter({ encounterType: "face_to_face", discipline: "md" });
const idg = (discipline: "rn" | "lpn" | "msw" | "chaplain" | "md" | "np") =>
  encounter({ encounterType: "idg_followup", discipline });

/** An M12 order as the provider returns it; only the fields the draft reads are filled. */
const activeOrder = (over: Record<string, unknown> = {}) =>
  order({
    id: "order-1",
    drugName: "Morphine sulfate",
    strength: "20 mg/mL",
    doseForm: "oral solution",
    route: "oral",
    sigStructured: { asNeeded: true },
    isSudTreatment: false,
    ...over,
  } as never);

const VITALS = { id: "vitals-1", recordedAt: "2026-11-18T14:20:00.000Z", heartRate: 72 };

const f2fPorts = (over: Parameters<typeof fakePorts>[0] = {}) =>
  fakePorts({
    activeMedicationsAsOf: async () => [activeOrder()],
    latestVitals: async () => VITALS as never,
    // A caregiver or an acknowledgment must never be read for a face-to-face visit: these answers would show if they were.
    caregiversOn: async () => {
      throw new Error("the face-to-face visit must not read the caregivers");
    },
    advanceDirectiveAcknowledgment: async () => {
      throw new Error("the face-to-face visit must not read the advance directive");
    },
    ...over,
  });

describe("what the face-to-face visit reads (S5, VN-D52)", () => {
  it("reads the orders in effect as of the visit time and the visit's recorded vitals", async () => {
    const ports = f2fPorts();
    const inputs = await readDraftInputs(ports, F2F_NP, viewer({ roles: ["np"] }), AS_OF);
    expect(ports.activeMedicationsAsOf).toHaveBeenCalledWith(
      F2F_NP.organizationId,
      F2F_NP.patientId,
      AS_OF,
    );
    expect(ports.latestVitals).toHaveBeenCalledWith(F2F_NP.id, AS_OF);
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
    expect(inputs.vitals).toMatchObject({ id: "vitals-1", heartRate: 72 });
  });

  it("reads neither the caregivers nor the advance directive, and returns none of those fields", async () => {
    const ports = f2fPorts();
    const inputs = await readDraftInputs(ports, F2F_MD, viewer({ roles: ["md"] }), AS_OF);
    expect(ports.caregiversOn).not.toHaveBeenCalled();
    expect(ports.advanceDirectiveAcknowledgment).not.toHaveBeenCalled();
    expect(inputs).not.toHaveProperty("caregivers");
    expect(inputs).not.toHaveProperty("advanceDirective");
  });

  it("reads neither the care plan nor the medication changes nor a discipline plan: those sections are the clinician's own (VN-D53)", async () => {
    const ports = f2fPorts();
    await readDraftInputs(ports, F2F_NP, viewer({ roles: ["np"] }), AS_OF);
    expect(ports.carePlanAsOf).not.toHaveBeenCalled();
    expect(ports.medicationChangesBetween).not.toHaveBeenCalled();
    expect(ports.disciplinePlanAsOf).not.toHaveBeenCalled();
  });

  it("leaves a SUD treatment order out for a viewer without Part 2 disclosure, and states it for one with", async () => {
    const orders = [
      activeOrder(),
      activeOrder({ id: "order-sud", drugName: "Buprenorphine", isSudTreatment: true }),
    ];
    const withheld = await readDraftInputs(
      f2fPorts({
        activeMedicationsAsOf: async () => orders,
        part2DisclosureAllowed: async () => false,
      }),
      F2F_NP,
      viewer({ roles: ["np"] }),
      AS_OF,
    );
    expect(withheld.activeMedications?.map((m) => m.id)).toEqual(["order-1"]);
    const disclosed = await readDraftInputs(
      f2fPorts({
        activeMedicationsAsOf: async () => orders,
        part2DisclosureAllowed: async () => true,
      }),
      F2F_NP,
      viewer({ roles: ["np"] }),
      AS_OF,
    );
    expect(disclosed.activeMedications?.map((m) => m.id).sort()).toEqual(["order-1", "order-sud"]);
  });

  it("fails closed when the Part 2 verdict cannot be had: a SUD order is not drafted", async () => {
    const orders = [activeOrder({ id: "order-sud", isSudTreatment: true })];
    await expect(
      readDraftInputs(
        f2fPorts({
          activeMedicationsAsOf: async () => orders,
          part2DisclosureAllowed: async () => {
            throw new Error("synthetic outage");
          },
        }),
        F2F_NP,
        viewer({ roles: ["np"] }),
        AS_OF,
      ),
    ).rejects.toThrow();
  });

  it("a source that cannot be read stops the draft instead of drafting short", async () => {
    for (const port of ["activeMedicationsAsOf", "latestVitals"] as const) {
      const ports = f2fPorts({
        [port]: async () => {
          throw new Error("synthetic outage");
        },
      });
      await expect(
        readDraftInputs(ports, F2F_NP, viewer({ roles: ["np"] }), AS_OF),
        port,
      ).rejects.toThrow();
    }
  });
});

describe("what the IDG follow-up reads (S5, VN-D52)", () => {
  it.each(["md", "np"] as const)(
    "%s reads the visit's recorded vitals and nothing else of the S1 sources, and no admission record",
    async (discipline) => {
      const ports = f2fPorts({ activeMedicationsAsOf: async () => [activeOrder()] });
      const inputs = await readDraftInputs(
        ports,
        idg(discipline),
        viewer({ roles: [discipline] }),
        AS_OF,
      );
      expect(ports.latestVitals).toHaveBeenCalled();
      expect(ports.carePlanAsOf).not.toHaveBeenCalled();
      expect(ports.medicationChangesBetween).not.toHaveBeenCalled();
      expect(ports.scaleSeries).not.toHaveBeenCalled();
      expect(ports.disciplinePlanAsOf).not.toHaveBeenCalled();
      expect(ports.activeMedicationsAsOf).not.toHaveBeenCalled();
      expect(ports.electionPeriods).not.toHaveBeenCalled();
      expect(inputs).not.toHaveProperty("activeMedications");
    },
  );

  it("an RN reads what the routine visit reads: the care plan, the scales, the vitals and the medication changes", async () => {
    const ports = fakePorts({
      previousSignedVisitAt: async () => new Date("2026-11-10T12:00:00.000Z"),
    });
    await readDraftInputs(ports, idg("rn"), viewer(), AS_OF);
    expect(ports.carePlanAsOf).toHaveBeenCalled();
    expect(ports.scaleSeries).toHaveBeenCalled();
    expect(ports.latestVitals).toHaveBeenCalled();
    expect(ports.medicationChangesBetween).toHaveBeenCalled();
    expect(ports.disciplinePlanAsOf).not.toHaveBeenCalled();
  });

  it("an LPN reads the care plan, the vitals and the medication changes, and never the scales", async () => {
    const ports = fakePorts({
      previousSignedVisitAt: async () => new Date("2026-11-10T12:00:00.000Z"),
    });
    await readDraftInputs(ports, idg("lpn"), viewer({ roles: ["lpn"] }), AS_OF);
    expect(ports.carePlanAsOf).toHaveBeenCalled();
    expect(ports.latestVitals).toHaveBeenCalled();
    expect(ports.medicationChangesBetween).toHaveBeenCalled();
    expect(ports.scaleSeries).not.toHaveBeenCalled();
  });

  it("a social worker reads the social-work plan and not the care plan, and a chaplain the spiritual plan", async () => {
    const msw = fakePorts();
    await readDraftInputs(msw, idg("msw"), viewer({ roles: ["msw"] }), AS_OF);
    expect(msw.disciplinePlanAsOf).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "msw_plan",
      expect.anything(),
      AS_OF,
    );
    expect(msw.carePlanAsOf).not.toHaveBeenCalled();
    expect(msw.latestVitals).not.toHaveBeenCalled();

    const chaplain = fakePorts();
    await readDraftInputs(chaplain, idg("chaplain"), viewer({ roles: ["chaplain"] }), AS_OF);
    expect(chaplain.disciplinePlanAsOf).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "spiritual_plan",
      expect.anything(),
      AS_OF,
    );
    expect(chaplain.carePlanAsOf).not.toHaveBeenCalled();
  });

  it("the telephonic visit of a physician or nurse practitioner reads nothing", async () => {
    for (const discipline of ["md", "np"] as const) {
      const ports = f2fPorts();
      await readDraftInputs(
        ports,
        encounter({ encounterType: "telephonic", discipline }),
        viewer({ roles: [discipline] }),
        AS_OF,
      );
      for (const port of [
        "carePlanAsOf",
        "latestVitals",
        "activeMedicationsAsOf",
        "scaleSeries",
        "medicationChangesBetween",
        "disciplinePlanAsOf",
      ] as const) {
        expect(ports[port], `${discipline} ${port}`).not.toHaveBeenCalled();
      }
    }
  });
});

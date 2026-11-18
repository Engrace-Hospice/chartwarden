// Visit-note closure clock (ADR-0113) at the M8 service layer: an ad-hoc note starts its own clock inside the
// INSERT; a seeded draft gets `draft_opened` on the author's first authoring write and never on a read or a
// sealed note. Driven over the recording Drizzle fake — the UPDATE ... WHERE semantics and the sign path need a
// real database (the live suite owns those).
import { describe, expect, it } from "vitest";
import { registerSeam } from "../src/bootstrap/index";
import { createDbEncounterRouteService } from "../src/modules/08-encounters/encounters-route-service-db";
import { type FakeRows, fakeDb } from "./_fake-drizzle";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const MEMBERSHIP = "44444444-4444-4444-8444-444444444444";
const ENCOUNTER = "55555555-5555-4555-8555-555555555555";
const VISIT = "66666666-6666-4666-8666-666666666666";
const SITE = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-11-17T15:00:00.000Z");
const EARLIER = new Date("2026-11-17T13:00:00.000Z");

registerSeam("AdmissionStatusReader", {
  getAdmissionSummary: async () => ({
    organizationId: ORG,
    patientId: PATIENT,
    status: "active",
    activatedAt: "2026-01-01",
    admissionAt: "2026-01-01",
    dischargedAt: null,
    providerEntityId: SITE,
    locationId: SITE,
  }),
} as never);

const encounterRow = (over: Record<string, unknown> = {}) => ({
  id: ENCOUNTER,
  organizationId: ORG,
  patientId: PATIENT,
  admissionId: ADMISSION,
  visitId: null,
  encounterType: "routine_visit",
  discipline: "rn",
  authoredByMembershipId: MEMBERSHIP,
  serviceDate: "2026-11-01",
  status: "draft",
  version: 0,
  clockStartedAt: null,
  clockStartSource: null,
  ...over,
});

function serviceOver(rows: Record<string, FakeRows>) {
  const { db, rec } = fakeDb(rows);
  return { service: createDbEncounterRouteService(db, undefined, undefined, () => NOW), rec };
}

const draftArgs = {
  patientId: PATIENT,
  admissionId: ADMISSION,
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate: "2026-11-01",
} as never;

describe("createDraft", () => {
  it("starts the clock at creation (draft_created) inside the INSERT for an ad-hoc note", async () => {
    const { service, rec } = serviceOver({ encounter: [encounterRow()] });
    await service.createDraft(ORG, MEMBERSHIP, draftArgs);
    expect(rec.inserts[0]?.table).toBe("encounter");
    expect(rec.inserts[0]?.values).toMatchObject({
      clockStartedAt: NOW,
      clockStartSource: "draft_created",
    });
    expect(rec.updates).toEqual([]); // no second UPDATE
  });

  it("leaves the clock to the visit-start event when the note is tied to a visit", async () => {
    const { service, rec } = serviceOver({ encounter: [encounterRow({ visitId: VISIT })] });
    await service.createDraft(ORG, MEMBERSHIP, {
      ...(draftArgs as object),
      visitId: VISIT,
    } as never);
    expect(rec.inserts[0]?.values).not.toHaveProperty("clockStartedAt");
    expect(rec.inserts[0]?.values).not.toHaveProperty("clockStartSource");
  });
});

describe("first authoring write", () => {
  const vitals = { heartRate: 72 } as never;
  const mileage = { source: "odometer", odometerStart: 100, odometerEnd: 112 } as never;
  const stampUpdate = {
    table: "encounter",
    set: { clockStartedAt: NOW, clockStartSource: "draft_opened" },
  };

  it("stamps draft_opened on the first vitals capture of an unclocked draft", async () => {
    const { service, rec } = serviceOver({
      encounter: [encounterRow()],
      vitals: [{ id: "v-1" }],
    });
    await service.captureVitals(ORG, ENCOUNTER, vitals);
    expect(rec.updates).toEqual([stampUpdate]);
  });

  it("stamps draft_opened on the first mileage capture of an unclocked draft", async () => {
    const { service, rec } = serviceOver({
      encounter: [encounterRow()],
      mileage: (op) => (op === "insert" ? [{ id: "m-1" }] : []),
    });
    await service.captureMileage(ORG, ENCOUNTER, mileage);
    expect(rec.updates).toEqual([stampUpdate]);
  });

  it("never moves a clock the note already has", async () => {
    const { service, rec } = serviceOver({
      encounter: [encounterRow({ clockStartedAt: EARLIER, clockStartSource: "evv_check_in" })],
      vitals: [{ id: "v-1" }],
    });
    await service.captureVitals(ORG, ENCOUNTER, vitals);
    expect(rec.updates).toEqual([]);
  });

  it.each(["signed", "cosign_pending", "cosigned", "voided"])(
    "refuses a write to a %s note without stamping it",
    async (status) => {
      const { service, rec } = serviceOver({
        encounter: [encounterRow({ status })],
        vitals: [{ id: "v-1" }],
      });
      await expect(service.captureVitals(ORG, ENCOUNTER, vitals)).rejects.toThrow();
      expect(rec.updates).toEqual([]);
    },
  );

  it("does not stamp on a read", async () => {
    const { service, rec } = serviceOver({ encounter: [encounterRow()] });
    await service.getTemplate(ORG, ENCOUNTER);
    expect(rec.updates).toEqual([]);
    expect(rec.inserts).toEqual([]);
  });
});

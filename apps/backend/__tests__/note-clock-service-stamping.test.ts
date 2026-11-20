// Visit-note closure clock (ADR-0113) at the M8 service layer: an ad-hoc note starts its own clock inside the
// INSERT; a seeded draft gets `draft_opened` on the author's first authoring write and never on a read or a
// sealed note. Driven over the recording Drizzle fake — the UPDATE ... WHERE semantics and the sign path need a
// real database (the live suite owns those).
import { describe, expect, it, vi } from "vitest";
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
const SUPERVISOR = "88888888-8888-4888-8888-888888888888";
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

/** The M17 `VisitReader` as this suite drives it: `visit` is what the seam answers, or `"throw"` for a seam that cannot answer. */
const visitSeam: { visit: Record<string, unknown> | null | "throw" } = { visit: null };
const visitForEncounter = vi.fn(async () => {
  if (visitSeam.visit === "throw") throw new Error("VisitReader unavailable");
  return visitSeam.visit;
});
registerSeam("VisitReader", { visitForEncounter } as never);
const visitRow = (over: Record<string, unknown> = {}) => ({
  id: VISIT,
  organizationId: ORG,
  assignedMembershipId: MEMBERSHIP,
  serviceDate: "2026-11-01",
  actualStartedAt: null,
  ...over,
});

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
  const withVisit = { ...(draftArgs as object), visitId: VISIT } as never;
  const created = async (visit: typeof visitSeam.visit) => {
    visitSeam.visit = visit;
    visitForEncounter.mockClear();
    const { service, rec } = serviceOver({ encounter: [encounterRow({ visitId: VISIT })] });
    await service.createDraft(ORG, MEMBERSHIP, withVisit);
    return rec.inserts[0]?.values;
  };

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

  it("an ad-hoc note never asks the visit seam anything", async () => {
    visitForEncounter.mockClear();
    const { service } = serviceOver({ encounter: [encounterRow()] });
    await service.createDraft(ORG, MEMBERSHIP, draftArgs);
    expect(visitForEncounter).not.toHaveBeenCalled();
  });

  it("leaves the clock to the visit-start event when the visit is the author's own and has not started", async () => {
    const values = await created(visitRow());
    expect(visitForEncounter).toHaveBeenCalledWith(ORG, VISIT);
    expect(values).not.toHaveProperty("clockStartedAt");
    expect(values).not.toHaveProperty("clockStartSource");
  });

  it.each([
    ["no visit with that id exists (a made-up uuid)", null],
    ["the visit is assigned to someone else", visitRow({ assignedMembershipId: SUPERVISOR })],
    ["the visit belongs to another organization", visitRow({ organizationId: "other-org" })],
    ["the visit seam cannot answer", "throw" as const],
    ["the visit has an unreadable start instant", visitRow({ actualStartedAt: "not-an-instant" })],
    [
      "the visit has an unreadable service date",
      visitRow({ actualStartedAt: EARLIER.toISOString(), serviceDate: "2026-02-30" }),
    ],
  ])(
    "starts the clock at creation (draft_created) when %s, so a typed visitId can neither defer it nor move it",
    async (_why, visit) => {
      const values = await created(visit);
      expect(values).toMatchObject({ clockStartedAt: NOW, clockStartSource: "draft_created" });
    },
  );

  describe("a visit that has ALREADY started and is the author's own: the clock is the ARRIVAL, not the creation", () => {
    it("self-attested start: the visit's actual start, source visit_started", async () => {
      const values = await created(
        visitRow({ actualStartedAt: EARLIER.toISOString(), evvBracketState: null }),
      );
      expect(values).toMatchObject({ clockStartedAt: EARLIER, clockStartSource: "visit_started" });
    });

    it("EVV-bracketed start: the same instant, source evv_check_in", async () => {
      const values = await created(
        visitRow({ actualStartedAt: EARLIER.toISOString(), evvBracketState: "evv_present" }),
      );
      expect(values).toMatchObject({ clockStartedAt: EARLIER, clockStartSource: "evv_check_in" });
    });

    it("never in the future: a start instant after now is held to now", async () => {
      const values = await created(
        visitRow({ actualStartedAt: "2026-11-17T21:00:00.000Z", evvBracketState: "evv_present" }),
      );
      expect(values).toMatchObject({ clockStartedAt: NOW, clockStartSource: "evv_check_in" });
    });

    it("never before the VISIT's service day: an earlier instant is lifted to that day's start", async () => {
      const values = await created(
        visitRow({ actualStartedAt: "2026-10-20T12:00:00.000Z", evvBracketState: null }),
      );
      expect(values).toMatchObject({
        clockStartedAt: new Date("2026-11-01T04:00:00.000Z"), // 00:00 EDT, the organization default zone America/New_York
        clockStartSource: "visit_started",
      });
    });

    it("the REQUEST's serviceDate never moves the clock: typing today for a visit that started days ago still clocks at the arrival", async () => {
      visitSeam.visit = visitRow({
        serviceDate: "2026-11-15",
        actualStartedAt: "2026-11-15T14:00:00.000Z",
        evvBracketState: "evv_present",
      });
      const { service, rec } = serviceOver({ encounter: [encounterRow({ visitId: VISIT })] });
      await service.createDraft(ORG, MEMBERSHIP, {
        ...(draftArgs as object),
        visitId: VISIT,
        serviceDate: "2026-11-17", // the clinician's own claim: today
      } as never);
      expect(rec.inserts[0]?.values).toMatchObject({
        clockStartedAt: new Date("2026-11-15T14:00:00.000Z"),
        clockStartSource: "evv_check_in",
      });
    });

    it("someone else's started visit is NOT followed: the clock starts at creation", async () => {
      const values = await created(
        visitRow({ assignedMembershipId: SUPERVISOR, actualStartedAt: EARLIER.toISOString() }),
      );
      expect(values).toMatchObject({ clockStartedAt: NOW, clockStartSource: "draft_created" });
    });
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
    await service.captureVitals(ORG, ENCOUNTER, vitals, MEMBERSHIP);
    expect(rec.updates).toEqual([stampUpdate]);
  });

  it("stamps draft_opened on the first mileage capture of an unclocked draft", async () => {
    const { service, rec } = serviceOver({
      encounter: [encounterRow()],
      mileage: (op) => (op === "insert" ? [{ id: "m-1" }] : []),
    });
    await service.captureMileage(ORG, ENCOUNTER, mileage, MEMBERSHIP);
    expect(rec.updates).toEqual([stampUpdate]);
  });

  it.each([
    ["a supervisor (not the author) edits the vitals", SUPERVISOR],
    ["the caller has no acting member (a system caller: null)", null],
  ])("does NOT stamp the author's clock when %s", async (_who, actor) => {
    const { service, rec } = serviceOver({
      encounter: [encounterRow()],
      vitals: [{ id: "v-1" }],
    });
    await service.captureVitals(ORG, ENCOUNTER, vitals, actor);
    expect(rec.updates).toEqual([]);
  });

  it("does NOT stamp when a supervisor edits the mileage of a legacy (clockless) draft (ADR-0113 D9)", async () => {
    const { service, rec } = serviceOver({
      encounter: [encounterRow()],
      mileage: (op) => (op === "insert" ? [{ id: "m-1" }] : []),
    });
    await service.editMileage(ORG, ENCOUNTER, mileage, SUPERVISOR);
    expect(rec.updates).toEqual([]);
  });

  it("stamps on the author's own vitals edit too (editVitals)", async () => {
    const { service, rec } = serviceOver({
      encounter: [encounterRow()],
      vitals: [{ id: "v-1" }],
    });
    await service.editVitals(ORG, ENCOUNTER, "v-1", vitals, MEMBERSHIP);
    expect(rec.updates[0]).toEqual(stampUpdate);
  });

  it("never moves a clock the note already has", async () => {
    const { service, rec } = serviceOver({
      encounter: [encounterRow({ clockStartedAt: EARLIER, clockStartSource: "evv_check_in" })],
      vitals: [{ id: "v-1" }],
    });
    await service.captureVitals(ORG, ENCOUNTER, vitals, MEMBERSHIP);
    expect(rec.updates).toEqual([]);
  });

  it.each(["signed", "cosign_pending", "cosigned", "voided"])(
    "refuses a write to a %s note without stamping it",
    async (status) => {
      const { service, rec } = serviceOver({
        encounter: [encounterRow({ status })],
        vitals: [{ id: "v-1" }],
      });
      await expect(service.captureVitals(ORG, ENCOUNTER, vitals, MEMBERSHIP)).rejects.toThrow();
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

describe("the acting user of an authoring write (S1: row-trigger audit images are the clinician's, not the system's)", () => {
  const USER = "99999999-9999-4999-8999-999999999999";
  const vitals = { heartRate: 72 } as never;

  it("files a vitals capture under the acting user", async () => {
    const { service, rec } = serviceOver({ encounter: [encounterRow()], vitals: [{ id: "v-1" }] });
    await service.captureVitals(ORG, ENCOUNTER, vitals, MEMBERSHIP, USER);
    expect(rec.actorUserIds).toEqual([USER]);
  });

  it("files a vitals edit under the acting user", async () => {
    const { service, rec } = serviceOver({ encounter: [encounterRow()], vitals: [{ id: "v-1" }] });
    await service.editVitals(ORG, ENCOUNTER, "v-1", vitals, MEMBERSHIP, USER);
    expect(rec.actorUserIds).toEqual([USER]);
  });

  it("a caller with no user (a system caller) is still filed under no user, never under the membership", async () => {
    const { service, rec } = serviceOver({ encounter: [encounterRow()], vitals: [{ id: "v-1" }] });
    await service.captureVitals(ORG, ENCOUNTER, vitals, null);
    expect(rec.actorUserIds).toEqual([""]);
  });
});

describe("the acting user of an addendum's creation", () => {
  const USER = "99999999-9999-4999-8999-999999999999";
  const created = (authorUserId?: string) => {
    const { service, rec } = serviceOver({
      encounter: [encounterRow({ status: "signed" })],
      encounter_addendum: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
    });
    return service
      .createAddendum(ORG, ENCOUNTER, {
        reason: "a correction",
        authorMembershipId: MEMBERSHIP,
        ...(authorUserId === undefined ? {} : { authorUserId }),
      })
      .then(() => rec.actorUserIds);
  };

  it("files the addendum row (and the sections it names) under its author", async () => {
    expect(await created(USER)).toEqual([USER]);
  });

  it("with no user it is filed under no user, never under the membership", async () => {
    expect(await created()).toEqual([""]);
  });
});

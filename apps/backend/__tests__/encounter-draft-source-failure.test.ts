// S1 rollout scope, the other half (ADR-0114, design §3.2): for the one template S1 drafts (the RN routine visit) a source that fails, or
// that never answers, still fails CLOSED with the codes it always had - never a pass, never a hung sign. A read that does not answer
// within `DRAFT_SOURCE_READ_TIMEOUT_MS` is `DRAFT_UNAVAILABLE`, which the gate and sign report as `COMPLIANCE_GATE_UNAVAILABLE` (503).
// Fake seams, in-memory store, fake timers; no database.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeDraft } from "../src/modules/08-encounters/drafting/compute";
import { createDraftService } from "../src/modules/08-encounters/drafting/draft-service";
import { readNoteDraft } from "../src/modules/08-encounters/drafting/note-draft";
import {
  DRAFT_SOURCE_READ_TIMEOUT_MS,
  guarded,
} from "../src/modules/08-encounters/drafting/unavailable";
import {
  NOW,
  carePlan,
  change,
  fakePorts,
  reader,
  selectionFor,
  viewer,
} from "./_encounter-draft-fixtures";
import { draftEncounterRow, memoryRunInOrg } from "./_encounter-draft-memory-store";

const outage = async (): Promise<never> => {
  throw new Error("synthetic upstream outage");
};
/** Never answers, and never fails. */
const hang = (): Promise<never> => new Promise<never>(() => undefined);

const SEAM_SOURCES = [
  "carePlanAsOf",
  "scaleSeries",
  "medicationChangesBetween",
  "part2DisclosureAllowed",
] as const;
const STORE_SOURCES = [
  "organizationTimeZone",
  "previousSignedVisitAt",
  "latestVitals",
  "removedCarePlanElementIds",
  "loadSelection",
] as const;
type Source = (typeof SEAM_SOURCES)[number] | (typeof STORE_SOURCES)[number];
const SOURCES: readonly Source[] = [...SEAM_SOURCES, ...STORE_SOURCES];

const encounter = draftEncounterRow();
const caller = {
  organizationId: encounter.organizationId,
  userId: "00000000-0000-4000-8000-0000000000bb",
  roles: ["rn"],
  membershipId: "00000000-0000-4000-8000-0000000000aa",
  permissions: new Set<string>(["care_plan.read", "prescribing.read", "assessment.read_trend"]),
};
const scope = { organizationId: encounter.organizationId, userId: "u", now: NOW };

/** Healthy seams that ask every source (a SUD order makes the draft ask for the Part 2 verdict); `broken` replaces one read by `how`. */
function harness(broken: Source | null, how: () => Promise<never>) {
  const seamOver = (name: Source) => (name === broken ? { [name]: how } : {});
  const seams = fakePorts({
    carePlanAsOf: async () => carePlan(),
    medicationChangesBetween: async () => [
      change("started", "2026-11-12T16:00:00.000Z", { id: "order-a", isSudTreatment: true }),
    ],
    ...Object.assign({}, ...SEAM_SOURCES.map(seamOver)),
  });
  const mem = memoryRunInOrg({ previous: new Date("2026-11-10T15:00:00.000Z") });
  for (const name of STORE_SOURCES) if (name === broken) mem.store[name].mockImplementation(how);
  return { seams, ...mem };
}

// The RN routine visit above reads neither M15's discipline plan nor this visit's removed discipline-plan links (`draftSourceNeeds`), so those two sources
// are exercised on the visit that does: a social worker's follow-up, by the gate and sign read, the draft read and the per-element list (S4b).
const MSW_SOURCES = ["disciplinePlanAsOf", "removedDisciplinePlanElementIds"] as const;
type MswSource = (typeof MSW_SOURCES)[number];
const mswEncounter = draftEncounterRow({ encounterType: "msw_followup", discipline: "msw" });
const MSW_PERMISSIONS = new Set(["discipline_plan.read"]);
const MSW_READER = reader({ roles: ["msw"], permissions: MSW_PERMISSIONS });
const mswCaller = { ...caller, roles: ["msw"], permissions: MSW_PERMISSIONS };

/** Healthy fakes for a social-work visit; `broken` replaces one of the two discipline-plan reads by `how`. */
function mswHarness(broken: MswSource | null, how: () => Promise<never>) {
  const seams = fakePorts(broken === "disciplinePlanAsOf" ? { disciplinePlanAsOf: how } : {});
  const mem = memoryRunInOrg({
    encounter: mswEncounter,
    selection: selectionFor("msw_followup", "msw"),
  });
  if (broken === "removedDisciplinePlanElementIds") {
    mem.store.removedDisciplinePlanElementIds.mockImplementation(how);
  }
  const svc = createDraftService({ runInOrg: mem.runInOrg, seams: () => seams, now: () => NOW });
  return { seams, ...mem, svc };
}

// S5b: the IDG follow-up visit's own section reads this visit's live link (a store read) and M14's open action items (a seam read). A viewer holding `idg.act`
// and a link makes both reads; either failing is the draft being unavailable, never a section quietly left out (the viewer without the key makes neither).
const IDG_SOURCES = ["idgFollowUpItems", "linkedIdgActionItemId"] as const;
type IdgSource = (typeof IDG_SOURCES)[number];
const idgEncounter = draftEncounterRow({ encounterType: "idg_followup", discipline: "msw" });
const IDG_PERMISSIONS = new Set(["discipline_plan.read", "idg.act"]);
const IDG_READER = reader({ roles: ["msw"], permissions: IDG_PERMISSIONS });
const idgCaller = { ...caller, roles: ["msw"], permissions: IDG_PERMISSIONS };
const IDG_ITEM = "00000000-0000-4000-8000-0000000000e1";

/** Healthy fakes for an IDG follow-up visit of a social worker, linked to an item; `broken` replaces one of the two IDG reads by `how`. */
function idgHarness(broken: IdgSource | null, how: () => Promise<never>) {
  const seams = fakePorts(broken === "idgFollowUpItems" ? { idgFollowUpItems: how } : {});
  const mem = memoryRunInOrg({
    encounter: idgEncounter,
    selection: selectionFor("idg_followup", "msw"),
    idgLinks: [
      {
        id: "idg-link-1",
        actionItemId: IDG_ITEM,
        removedAt: null,
        removedByMembershipId: null,
        part2Derived: false,
        linkedByMembershipId: caller.membershipId,
      },
    ],
  });
  if (broken === "linkedIdgActionItemId") mem.store.linkedIdgActionItemId.mockImplementation(how);
  const svc = createDraftService({ runInOrg: mem.runInOrg, seams: () => seams, now: () => NOW });
  return { seams, ...mem, svc };
}

/** The read's outcome after `ms` of fake time: the error it failed with, `"resolved"`, or `"pending"` if it is still waiting. */
async function outcomeAfter(read: Promise<unknown>, ms: number): Promise<unknown> {
  const settled = read.then(
    () => "resolved",
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(ms);
  return Promise.race([settled, Promise.resolve("pending")]);
}

describe("an RN routine visit whose source fails", () => {
  for (const source of SOURCES) {
    it(`${source}: the gate and sign read is COMPLIANCE_GATE_UNAVAILABLE (503), never a pass`, async () => {
      const { seams, runInOrg } = harness(source, outage);
      const error = await runInOrg(scope, (unit) =>
        readNoteDraft(unit, seams, encounter, reader(), NOW),
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "COMPLIANCE_GATE_UNAVAILABLE", statusCode: 503 });
      expect((error as Error).message).not.toContain("synthetic upstream outage");
    });

    it(`${source}: the draft read is DRAFT_UNAVAILABLE (503)`, async () => {
      const { seams, runInOrg } = harness(source, outage);
      const svc = createDraftService({ runInOrg, seams: () => seams, now: () => NOW });
      const error = await svc.getDraft(caller, encounter.id).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "DRAFT_UNAVAILABLE", statusCode: 503 });
    });
  }
});

describe("an RN routine visit whose source never answers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  for (const source of SOURCES) {
    it(`${source}: the gate and sign read gives up after the bound with COMPLIANCE_GATE_UNAVAILABLE`, async () => {
      const { seams, runInOrg } = harness(source, hang);
      const read = runInOrg(scope, (unit) => readNoteDraft(unit, seams, encounter, reader(), NOW));
      expect(await outcomeAfter(read, DRAFT_SOURCE_READ_TIMEOUT_MS + 1)).toMatchObject({
        code: "COMPLIANCE_GATE_UNAVAILABLE",
        statusCode: 503,
      });
    });
  }

  it("the draft read gives up after the bound with DRAFT_UNAVAILABLE, naming the read and not the cause", async () => {
    const { seams, runInOrg } = harness("carePlanAsOf", hang);
    const svc = createDraftService({ runInOrg, seams: () => seams, now: () => NOW });
    const outcome = await outcomeAfter(
      svc.getDraft(caller, encounter.id),
      DRAFT_SOURCE_READ_TIMEOUT_MS + 1,
    );
    expect(outcome).toMatchObject({ code: "DRAFT_UNAVAILABLE", statusCode: 503 });
    expect((outcome as Error).message).toContain("the care plan");
  });

  it("does not give up before the bound: a slow answer inside it is used", async () => {
    const slow = async () => {
      await new Promise((resolve) => setTimeout(resolve, DRAFT_SOURCE_READ_TIMEOUT_MS - 1));
      return carePlan();
    };
    const { seams, store } = harness(null, hang);
    seams.carePlanAsOf.mockImplementation(slow);
    const read = computeDraft({ ...seams, ...store }, encounter, viewer(), NOW);
    expect(await outcomeAfter(read, DRAFT_SOURCE_READ_TIMEOUT_MS)).toBe("resolved");
  });

  it("a read that answers after the bound is not an unhandled rejection", async () => {
    let fail: (reason: Error) => void = () => undefined;
    const late = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    const outcome = await outcomeAfter(
      guarded("a late read", () => late),
      DRAFT_SOURCE_READ_TIMEOUT_MS + 1,
    );
    expect(outcome).toMatchObject({ code: "DRAFT_UNAVAILABLE" });
    fail(new Error("answered too late"));
    await vi.advanceTimersByTimeAsync(1);
  });
});

// ── S2: the recertification visit reads the admission's benefit period, level of care, face-to-face and certification (M6) and the weights ──
const recertEncounter = draftEncounterRow({ encounterType: "recert_visit", discipline: "rn" });
/** A reader holding the four M6 read keys a recertification draft needs (`assertMayReadAdmissionFacts`). */
const ADMISSION_READER = reader({
  permissions: new Set([
    "election.read",
    "cti.read",
    "f2f.read",
    "loc.read",
    "care_plan.read",
    "prescribing.read",
    "assessment.read_trend",
  ]),
});
const RECERT_SEAM_SOURCES = [
  "electionPeriods",
  "levelOfCareOn",
  "attestedFaceToFace",
  "activeCertification",
] as const;
type RecertSource = (typeof RECERT_SEAM_SOURCES)[number] | "weightReadings";
const RECERT_SOURCES: readonly RecertSource[] = [...RECERT_SEAM_SOURCES, "weightReadings"];
const COVERING_PERIOD = {
  periodId: "period-3",
  admissionId: recertEncounter.admissionId,
  sequence: 3,
  periodKind: "ninety_day",
  status: "active",
  startDate: "2026-10-15",
  endDate: "2027-01-12",
  actualEndDate: null,
} as never;

/** Healthy seams with a period covering the visit, so every M6 read is asked; `broken` replaces one of them by `how`. */
function recertHarness(broken: RecertSource | null, how: () => Promise<never>) {
  const seams = fakePorts({
    carePlanAsOf: async () => carePlan(),
    electionPeriods: async () => [COVERING_PERIOD],
    ...(broken !== null && broken !== "weightReadings" ? { [broken]: how } : {}),
  });
  const mem = memoryRunInOrg({
    previous: new Date("2026-11-10T15:00:00.000Z"),
    encounter: recertEncounter,
    selection: selectionFor("recert_visit", "rn"),
  });
  if (broken === "weightReadings") mem.store.weightReadings.mockImplementation(how);
  return { seams, ...mem };
}

describe("an RN recertification visit whose source fails", () => {
  for (const source of RECERT_SOURCES) {
    it(`${source}: the gate and sign read is COMPLIANCE_GATE_UNAVAILABLE (503), and the draft read DRAFT_UNAVAILABLE (503)`, async () => {
      const gate = recertHarness(source, outage);
      const gateError = await gate
        .runInOrg(scope, (unit) =>
          readNoteDraft(unit, gate.seams, recertEncounter, ADMISSION_READER, NOW),
        )
        .catch((e: unknown) => e);
      expect(gateError).toMatchObject({ code: "COMPLIANCE_GATE_UNAVAILABLE", statusCode: 503 });
      expect((gateError as Error).message).not.toContain("synthetic upstream outage");

      const read = recertHarness(source, outage);
      const svc = createDraftService({
        runInOrg: read.runInOrg,
        seams: () => read.seams,
        now: () => NOW,
      });
      const error = await svc
        .getDraft(
          {
            ...caller,
            permissions: new Set([
              "election.read",
              "cti.read",
              "f2f.read",
              "loc.read",
              "care_plan.read",
              "prescribing.read",
              "assessment.read_trend",
            ]),
          },
          recertEncounter.id,
        )
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "DRAFT_UNAVAILABLE", statusCode: 503 });
    });
  }
});

describe("an RN recertification visit whose source never answers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  for (const source of RECERT_SOURCES) {
    it(`${source}: the gate and sign read gives up after the bound with COMPLIANCE_GATE_UNAVAILABLE`, async () => {
      const { seams, runInOrg } = recertHarness(source, hang);
      const read = runInOrg(scope, (unit) =>
        readNoteDraft(unit, seams, recertEncounter, ADMISSION_READER, NOW),
      );
      expect(await outcomeAfter(read, DRAFT_SOURCE_READ_TIMEOUT_MS + 1)).toMatchObject({
        code: "COMPLIANCE_GATE_UNAVAILABLE",
        statusCode: 503,
      });
    });
  }
});

describe("a social-work visit whose discipline-plan source fails", () => {
  for (const source of MSW_SOURCES) {
    it(`${source}: the gate and sign read is COMPLIANCE_GATE_UNAVAILABLE (503), the draft read and the element list DRAFT_UNAVAILABLE (503)`, async () => {
      const gate = mswHarness(source, outage);
      const gateError = await gate
        .runInOrg(scope, (unit) => readNoteDraft(unit, gate.seams, mswEncounter, MSW_READER, NOW))
        .catch((e: unknown) => e);
      expect(gateError).toMatchObject({ code: "COMPLIANCE_GATE_UNAVAILABLE", statusCode: 503 });
      expect((gateError as Error).message).not.toContain("synthetic upstream outage");

      const draftError = await mswHarness(source, outage)
        .svc.getDraft(mswCaller, mswEncounter.id)
        .catch((e: unknown) => e);
      expect(draftError).toMatchObject({ code: "DRAFT_UNAVAILABLE", statusCode: 503 });

      const listError = await mswHarness(source, outage)
        .svc.getDisciplinePlanElements(mswCaller, mswEncounter.id)
        .catch((e: unknown) => e);
      expect(listError).toMatchObject({ code: "DRAFT_UNAVAILABLE", statusCode: 503 });
    });
  }
});

describe("a social-work visit whose discipline-plan source never answers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  for (const source of MSW_SOURCES) {
    it(`${source}: the gate and sign read and the element list give up after the bound`, async () => {
      const gate = mswHarness(source, hang);
      const gateRead = gate.runInOrg(scope, (unit) =>
        readNoteDraft(unit, gate.seams, mswEncounter, MSW_READER, NOW),
      );
      expect(await outcomeAfter(gateRead, DRAFT_SOURCE_READ_TIMEOUT_MS + 1)).toMatchObject({
        code: "COMPLIANCE_GATE_UNAVAILABLE",
        statusCode: 503,
      });

      const list = mswHarness(source, hang).svc.getDisciplinePlanElements(
        mswCaller,
        mswEncounter.id,
      );
      expect(await outcomeAfter(list, DRAFT_SOURCE_READ_TIMEOUT_MS + 1)).toMatchObject({
        code: "DRAFT_UNAVAILABLE",
        statusCode: 503,
      });
    });
  }
});

describe("an IDG follow-up visit whose IDG source fails", () => {
  for (const source of IDG_SOURCES) {
    it(`${source}: the gate and sign read is COMPLIANCE_GATE_UNAVAILABLE (503), the draft read and the picker list DRAFT_UNAVAILABLE (503)`, async () => {
      const gate = idgHarness(source, outage);
      const gateError = await gate
        .runInOrg(scope, (unit) => readNoteDraft(unit, gate.seams, idgEncounter, IDG_READER, NOW))
        .catch((e: unknown) => e);
      expect(gateError).toMatchObject({ code: "COMPLIANCE_GATE_UNAVAILABLE", statusCode: 503 });
      expect((gateError as Error).message).not.toContain("synthetic upstream outage");

      const draftError = await idgHarness(source, outage)
        .svc.getDraft(idgCaller, idgEncounter.id)
        .catch((e: unknown) => e);
      expect(draftError).toMatchObject({ code: "DRAFT_UNAVAILABLE", statusCode: 503 });

      const listError = await idgHarness(source, outage)
        .svc.getIdgActionItems(idgCaller, idgEncounter.id)
        .catch((e: unknown) => e);
      expect(listError).toMatchObject({ code: "DRAFT_UNAVAILABLE", statusCode: 503 });
    });
  }

  it("a viewer without idg.act never makes either read, so a broken IDG source does not touch their draft (VN-D66)", async () => {
    const keyless = { ...idgCaller, permissions: new Set(["discipline_plan.read"]) };
    for (const source of IDG_SOURCES) {
      const harness = idgHarness(source, outage);
      const draft = await harness.svc.getDraft(keyless, idgEncounter.id);
      expect(draft.sections.find((s) => s.sectionId === "idg_followup")).toMatchObject({
        state: "not_drafted",
      });
    }
  });
});

describe("an IDG follow-up visit whose IDG source never answers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  for (const source of IDG_SOURCES) {
    it(`${source}: the gate and sign read and the picker list give up after the bound`, async () => {
      const gate = idgHarness(source, hang);
      const gateRead = gate.runInOrg(scope, (unit) =>
        readNoteDraft(unit, gate.seams, idgEncounter, IDG_READER, NOW),
      );
      expect(await outcomeAfter(gateRead, DRAFT_SOURCE_READ_TIMEOUT_MS + 1)).toMatchObject({
        code: "COMPLIANCE_GATE_UNAVAILABLE",
        statusCode: 503,
      });

      const list = idgHarness(source, hang).svc.getIdgActionItems(idgCaller, idgEncounter.id);
      expect(await outcomeAfter(list, DRAFT_SOURCE_READ_TIMEOUT_MS + 1)).toMatchObject({
        code: "DRAFT_UNAVAILABLE",
        statusCode: 503,
      });
    });
  }
});

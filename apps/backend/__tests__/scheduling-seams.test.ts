import type { OnCallRosterEntry, PortalVisitSummary, VisitDto } from "@chartwarden/types";
// apps/backend/__tests__/scheduling-seams.test.ts — M17-T05 (§4.3 the four published reader seams). All four are
// pure READ-only orchestration over an injected SchedulingSeamStore; these cover the visit reads (encounter
// context / EVV geofence-on-date / IDG completed-since), the §4.5 D11 caseload-contribution assignment projection
// (active-on-date narrowing to published/en_route/in_visit), the on-call roster window + live in_visit reads, the
// M31 portal upcoming projection (scheduler-internal notes never cross), and the M30/M33 metric derivations
// (on-time / no-show / reschedule rates + stability = 1 − reschedule-rate + route efficiency) — plus the boot
// wiring (registerSchedulingSeams replaces the deny-stubs; validateSeams passes; the deny-stubs deny).
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, getSeam, validateSeams } from "../src/bootstrap/index";
import {
  type SchedulingSeamSeed,
  createInMemorySchedulingSeamStore,
  createPortalVisitReader,
  createVisitAssignmentReader,
  createVisitMetricsProvider,
  createVisitReader,
  registerSchedulingSeams,
} from "../src/modules/17-scheduling/index";

const ORG = "org-1";
const PAT = "pat-1";
const MEM = "mem-rn";

function visit(over: Partial<VisitDto>): VisitDto {
  return {
    id: "vis-1",
    organizationId: ORG,
    providerEntityId: "pe-1",
    locationId: "loc-1",
    patientId: PAT,
    admissionId: "adm-1",
    patientAddressId: "addr-1",
    externalFacilityId: null,
    assignedMembershipId: MEM,
    assignedDisciplineAtAssignment: "rn",
    visitPurpose: "routine_visit",
    visitSetting: "patient_home",
    scheduledStartedAt: "2026-03-05T14:00:00.000Z",
    scheduledEndedAt: "2026-03-05T15:00:00.000Z",
    serviceDate: "2026-03-05",
    actualStartedAt: null,
    actualEndedAt: null,
    status: "published",
    evvBracketState: null,
    encounterId: null,
    ...over,
  };
}

function seed(): SchedulingSeamSeed {
  const roster: OnCallRosterEntry[] = [
    {
      membershipId: MEM,
      discipline: "rn",
      fromIso: "2026-03-05T17:00:00.000Z",
      toIso: "2026-03-06T05:00:00.000Z",
    },
    {
      membershipId: "mem-md",
      discipline: "physician",
      fromIso: "2026-03-07T17:00:00.000Z",
      toIso: "2026-03-08T05:00:00.000Z",
    },
  ];
  const portal: PortalVisitSummary = {
    visitId: "vis-portal",
    scheduledStartedAt: "2026-03-06T14:00:00.000Z",
    scheduledEndedAt: "2026-03-06T15:00:00.000Z",
    visitPurposeLabel: "Nurse visit",
    clinicianDisplayName: "Sarah R.",
    visitSetting: "patient_home",
  };
  return {
    visits: [
      // on-time completed (actualStart <= scheduledStart)
      visit({ id: "vis-ontime", status: "completed", actualStartedAt: "2026-03-05T13:58:00.000Z" }),
      // late completed (actualStart after scheduledStart) — counts toward total, not on-time
      visit({
        id: "vis-late",
        status: "completed",
        scheduledStartedAt: "2026-03-05T16:00:00.000Z",
        scheduledEndedAt: "2026-03-05T17:00:00.000Z",
        serviceDate: "2026-03-05",
        actualStartedAt: "2026-03-05T16:20:00.000Z",
      }),
      // a no-show
      visit({
        id: "vis-noshow",
        status: "no_show",
        scheduledStartedAt: "2026-03-05T18:00:00.000Z",
      }),
      // a reschedule
      visit({
        id: "vis-resched",
        status: "rescheduled",
        scheduledStartedAt: "2026-03-05T19:00:00.000Z",
      }),
      // currently in_visit (live-awareness) + active assignment
      visit({ id: "vis-live", status: "in_visit", scheduledStartedAt: "2026-03-05T20:00:00.000Z" }),
      // a proposed visit — excluded from the active caseload contribution + the stability denominator
      visit({
        id: "vis-proposed",
        status: "proposed",
        scheduledStartedAt: "2026-03-05T21:00:00.000Z",
      }),
      // a different membership on the same date (proves filtering)
      visit({ id: "vis-other", assignedMembershipId: "mem-other", patientId: "pat-2" }),
      // an MD-discipline visit (proves the on-time discipline filter)
      visit({
        id: "vis-md",
        status: "completed",
        assignedDisciplineAtAssignment: "physician",
        actualStartedAt: "2026-03-05T13:00:00.000Z",
      }),
    ],
    onCallRoster: roster,
    portalSummaries: [{ patientId: PAT, summary: portal }],
    routeEfficiency: [
      {
        membershipId: MEM,
        window: { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" },
        efficiency: { totalProposedMiles: 40, totalActualMiles: 44, overrideRate: 0.25 },
      },
    ],
  };
}

const WINDOW = { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" };

describe("VisitReader (§4.3)", () => {
  const reader = () => createVisitReader(createInMemorySchedulingSeamStore(seed()).store);

  it("visitForEncounter resolves by id; null when absent", async () => {
    expect((await reader().visitForEncounter(ORG, "vis-live"))?.id).toBe("vis-live");
    expect(await reader().visitForEncounter(ORG, "missing")).toBeNull();
  });

  it("visitsScheduledForMembershipOnDate narrows by membership + service date (EVV geofence target)", async () => {
    const out = await reader().visitsScheduledForMembershipOnDate(ORG, MEM, "2026-03-05");
    expect(out.every((v) => v.assignedMembershipId === MEM && v.serviceDate === "2026-03-05")).toBe(
      true,
    );
    expect(out.some((v) => v.id === "vis-other")).toBe(false);
    expect(await reader().visitsScheduledForMembershipOnDate(ORG, MEM, "2026-03-09")).toEqual([]);
  });

  it("completedVisitsForPatientSince returns completed visits on/after the cutoff (IDG since-meeting)", async () => {
    const out = await reader().completedVisitsForPatientSince(ORG, PAT, "2026-03-05T00:00:00.000Z");
    expect(out.map((v) => v.id).sort()).toEqual(["vis-late", "vis-md", "vis-ontime"]);
    expect(out.every((v) => v.status === "completed")).toBe(true);
  });
});

describe("VisitReader.nextScheduledVisitForPatient (messaging hub WP 3.1)", () => {
  const AS_OF = "2026-03-05T16:00:00.000Z";
  const readerOver = (visits: VisitDto[]) =>
    createVisitReader(createInMemorySchedulingSeamStore({ visits }).store);

  it("returns the earliest future published visit as a free-text-free summary with asOf", async () => {
    const out = await readerOver([
      visit({ id: "later", scheduledStartedAt: "2026-03-08T14:00:00.000Z" }),
      visit({ id: "soon", scheduledStartedAt: "2026-03-06T14:00:00.000Z" }),
    ]).nextScheduledVisitForPatient(ORG, PAT, AS_OF);
    expect(out).toEqual({
      visitId: "soon",
      visitPurpose: "routine_visit",
      discipline: "rn",
      scheduledStartedAt: "2026-03-06T14:00:00.000Z",
      scheduledEndedAt: "2026-03-05T15:00:00.000Z",
      status: "published",
      asOf: AS_OF,
    });
  });

  it("excludes cancelled/completed/no_show/rescheduled/proposed, past, and other patients", async () => {
    const f = "2026-03-07T14:00:00.000Z";
    const out = await readerOver([
      visit({ id: "c", status: "cancelled", scheduledStartedAt: f }),
      visit({ id: "d", status: "completed", scheduledStartedAt: f }),
      visit({ id: "n", status: "no_show", scheduledStartedAt: f }),
      visit({ id: "r", status: "rescheduled", scheduledStartedAt: f }),
      visit({ id: "p", status: "proposed", scheduledStartedAt: f }),
      visit({ id: "past", scheduledStartedAt: "2026-03-05T10:00:00.000Z" }),
      visit({ id: "other", patientId: "pat-2", scheduledStartedAt: f }),
    ]).nextScheduledVisitForPatient(ORG, PAT, AS_OF);
    expect(out).toBeNull();
  });

  it("is org-explicit: a visit of another org is not returned", async () => {
    const out = await readerOver([
      visit({ id: "x", organizationId: "org-2", scheduledStartedAt: "2026-03-07T14:00:00.000Z" }),
    ]).nextScheduledVisitForPatient(ORG, PAT, AS_OF);
    expect(out).toBeNull();
  });

  it("fails closed on an empty org id or an unparseable asOf", async () => {
    const r = readerOver([]);
    await expect(r.nextScheduledVisitForPatient("", PAT, AS_OF)).rejects.toThrow();
    await expect(r.nextScheduledVisitForPatient(ORG, PAT, "not-a-date")).rejects.toThrow();
  });
});

describe("VisitReader.linkSummary (messaging hub WP 3.2)", () => {
  const readerOver = (visits: VisitDto[]) =>
    createVisitReader(createInMemorySchedulingSeamStore({ visits }).store);

  it("returns exactly id, patientId, status, occurredAt", async () => {
    const out = await readerOver([
      visit({ id: "v1", status: "published", scheduledStartedAt: "2026-03-06T14:00:00.000Z" }),
    ]).linkSummary(ORG, "v1");
    expect(out).toEqual({
      id: "v1",
      patientId: PAT,
      status: "published",
      occurredAt: "2026-03-06T14:00:00.000Z",
    });
    expect(Object.keys(out ?? {}).sort()).toEqual(["id", "occurredAt", "patientId", "status"]);
  });

  it("returns null for an unknown id and for another org's visit", async () => {
    const r = readerOver([visit({ id: "v1", organizationId: "org-2" })]);
    expect(await r.linkSummary(ORG, "nope")).toBeNull();
    expect(await r.linkSummary(ORG, "v1")).toBeNull();
  });

  it("fails closed on a blank org or id", async () => {
    const r = readerOver([visit({ id: "v1" })]);
    await expect(r.linkSummary("", "v1")).rejects.toThrow();
    await expect(r.linkSummary(ORG, " ")).rejects.toThrow();
  });
});

describe("VisitAssignmentReader (§4.5 D11 caseload contribution)", () => {
  const reader = () => createVisitAssignmentReader(createInMemorySchedulingSeamStore(seed()).store);

  it("activeVisitsForMembershipOnDate yields only published/en_route/in_visit assignments", async () => {
    const out = await reader().activeVisitsForMembershipOnDate(ORG, MEM, "2026-03-05");
    // vis-ontime/vis-late/vis-md are completed, vis-noshow/vis-resched terminal, vis-proposed pre-publish → excluded.
    expect(out.map((a) => a.visitId)).toEqual(["vis-live"]);
    expect(out[0]).toMatchObject({ patientId: PAT, assignedMembershipId: MEM, status: "in_visit" });
  });

  it("tonightsOnCallRoster returns only entries whose window contains asOf", async () => {
    const out = await reader().tonightsOnCallRoster(ORG, "2026-03-05T20:00:00.000Z");
    expect(out.map((r) => r.membershipId)).toEqual([MEM]);
  });

  it("currentVisitForClinician returns the live in_visit, else null", async () => {
    expect((await reader().currentVisitForClinician(ORG, MEM))?.id).toBe("vis-live");
    expect(await reader().currentVisitForClinician(ORG, "mem-other")).toBeNull();
  });
});

describe("PortalVisitReader (§4.3)", () => {
  it("upcomingForPatient returns the lay-language summary (no scheduler-internal notes in the shape)", async () => {
    const reader = createPortalVisitReader(createInMemorySchedulingSeamStore(seed()).store);
    const out = await reader.upcomingForPatient(ORG, PAT, 48);
    expect(out).toEqual([
      {
        visitId: "vis-portal",
        scheduledStartedAt: "2026-03-06T14:00:00.000Z",
        scheduledEndedAt: "2026-03-06T15:00:00.000Z",
        visitPurposeLabel: "Nurse visit",
        clinicianDisplayName: "Sarah R.",
        visitSetting: "patient_home",
      },
    ]);
    expect(await reader.upcomingForPatient(ORG, "pat-none", 48)).toEqual([]);
  });
});

describe("VisitMetricsProvider (§4.3)", () => {
  const provider = () =>
    createVisitMetricsProvider(createInMemorySchedulingSeamStore(seed()).store);

  it("getOnTimeVisitRate = on-time ÷ total scheduled in window", async () => {
    // 8 visits in window; on-time (actualStart <= scheduledStart): vis-ontime, vis-md → 2/8.
    expect(await provider().getOnTimeVisitRate(ORG, WINDOW)).toBe(2 / 8);
    // discipline filter narrows to the physician visit (vis-md), which is on-time → 1/1.
    expect(await provider().getOnTimeVisitRate(ORG, WINDOW, { discipline: "physician" })).toBe(1);
  });

  it("getNoShowRate = no-show ÷ total scheduled in window", async () => {
    expect(await provider().getNoShowRate(ORG, WINDOW)).toBe(1 / 8);
  });

  it("getRescheduleRate = rescheduled ÷ published (non-proposed)", async () => {
    // published denominator excludes vis-proposed → 7; one rescheduled → 1/7.
    expect(await provider().getRescheduleRate(ORG, WINDOW)).toBe(1 / 7);
  });

  it("getScheduleStabilityIndex = 1 − reschedule-rate", async () => {
    expect(await provider().getScheduleStabilityIndex(ORG, WINDOW)).toBe(1 - 1 / 7);
  });

  it("getRouteEfficiencyForMembership passes the proposed/actual/override rollup through", async () => {
    expect(await provider().getRouteEfficiencyForMembership(ORG, MEM, WINDOW)).toEqual({
      totalProposedMiles: 40,
      totalActualMiles: 44,
      overrideRate: 0.25,
    });
    // unknown membership → null-safe zeroed rollup.
    expect(await provider().getRouteEfficiencyForMembership(ORG, "mem-x", WINDOW)).toEqual({
      totalProposedMiles: 0,
      totalActualMiles: 0,
      overrideRate: 0,
    });
  });

  it("vacuous window: on-time/stability are 1, no-show/reschedule are 0", async () => {
    const empty = createVisitMetricsProvider(createInMemorySchedulingSeamStore().store);
    const noVisits = { from: "2030-01-01T00:00:00.000Z", to: "2030-02-01T00:00:00.000Z" };
    expect(await empty.getOnTimeVisitRate(ORG, noVisits)).toBe(1);
    expect(await empty.getNoShowRate(ORG, noVisits)).toBe(0);
    expect(await empty.getRescheduleRate(ORG, noVisits)).toBe(0);
    expect(await empty.getScheduleStabilityIndex(ORG, noVisits)).toBe(1);
  });
});

describe("boot wiring (registerSchedulingSeams)", () => {
  afterEach(() => __resetSeamsForTest());

  it("registers all four seams so validateSeams passes and they resolve as real impls", async () => {
    registerSchedulingSeams({ store: createInMemorySchedulingSeamStore(seed()).store });
    expect(() => validateSeams()).not.toThrow();
    expect((await getSeam("VisitReader").visitForEncounter(ORG, "vis-live"))?.id).toBe("vis-live");
    expect((await getSeam("VisitAssignmentReader").currentVisitForClinician(ORG, MEM))?.id).toBe(
      "vis-live",
    );
    expect(await getSeam("PortalVisitReader").upcomingForPatient(ORG, PAT, 48)).toHaveLength(1);
    expect(await getSeam("VisitMetricsProvider").getNoShowRate(ORG, WINDOW)).toBe(1 / 8);
  });

  it("falls back to fail-closed deny-stubs when M17 does not register", () => {
    validateSeams();
    expect(() => getSeam("VisitReader").visitForEncounter(ORG, "vis-1")).toThrow(/not implemented/);
    expect(() => getSeam("VisitAssignmentReader").currentVisitForClinician(ORG, MEM)).toThrow(
      /not implemented/,
    );
    expect(() => getSeam("PortalVisitReader").upcomingForPatient(ORG, PAT, 48)).toThrow(
      /not implemented/,
    );
    expect(() => getSeam("VisitMetricsProvider").getNoShowRate(ORG, WINDOW)).toThrow(
      /not implemented/,
    );
  });
});

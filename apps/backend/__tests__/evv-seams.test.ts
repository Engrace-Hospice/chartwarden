import type {
  EvvAggregatorSubmissionDto,
  EvvBracketDto,
  EvvEventDto,
  EvvLocationDto,
} from "@chartwarden/types";
// apps/backend/__tests__/evv-seams.test.ts — M18-T05 (§4.3 the six published reader seams). All six are pure
// READ-only orchestration over an injected EvvSeamStore; these cover the EvvBracketResolver mapping down to M8's
// EXISTING `resolveBracket` contract (present → evv_present with authoritative instants; documented → null-safe
// event ids; missing_open / no_evv_path → null so M8's fallback owns it), the billing-compliance verdict
// (ADR-0008 — only unresolved_missing blocks), the aggregator transaction-id back-link, the coordinate-bearing
// last-known-location reads, the M30/M33 metric derivations (compliance reuses the EvvComplianceDto; the bad-event
// rates are vacuously 0, the aggregator success rate vacuously 1), and the timestamp-only portal verification
// surface — plus the boot wiring (registerEvvSeams replaces the deny-stubs; validateSeams passes; the deny-stubs deny).
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, getSeam, validateSeams } from "../src/bootstrap/index";
import {
  type EvvSeamSeed,
  createEvvAggregatorReferenceReader,
  createEvvBracketResolver,
  createEvvComplianceReader,
  createEvvLocationProvider,
  createEvvMetricsProvider,
  createEvvVerificationProvider,
  createInMemoryEvvSeamStore,
  registerEvvSeams,
} from "../src/modules/18-evv/index";

const ORG = "org-1";
const PAT = "pat-1";
const MEM = "mem-rn";

function event(over: Partial<EvvEventDto>): EvvEventDto {
  return {
    id: "evt-in",
    organizationId: ORG,
    visitId: "vis-1",
    patientId: PAT,
    kind: "check_in",
    serviceTypeCode: "T1019",
    postingMembershipId: MEM,
    postingDisciplineAtRecording: "rn",
    evvDeviceId: "dev-1",
    capturedAt: "2026-03-05T14:01:00.000Z",
    recordedAt: "2026-03-05T14:01:03.000Z",
    gpsQuality: "high",
    offlineCapture: false,
    replacesEventId: null,
    supersededByEventId: null,
    ...over,
  };
}

const WINDOW = { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" };

function seed(): EvvSeamSeed {
  const checkIn = event({ id: "evt-in", kind: "check_in", capturedAt: "2026-03-05T14:01:00.000Z" });
  const checkOut = event({
    id: "evt-out",
    kind: "check_out",
    capturedAt: "2026-03-05T15:02:00.000Z",
  });
  const presentBracket: EvvBracketDto = {
    visitId: "vis-present",
    checkInEvent: { ...checkIn, visitId: "vis-present" },
    checkOutEvent: { ...checkOut, visitId: "vis-present" },
    bracketState: "present",
    missingResolution: null,
  };
  const documentedBracket: EvvBracketDto = {
    visitId: "vis-doc",
    checkInEvent: { ...checkIn, visitId: "vis-doc" },
    checkOutEvent: null,
    bracketState: "missing_documented",
    missingResolution: {
      id: "mr-1",
      visitId: "vis-doc",
      kind: "missing_checkout",
      status: "closed_clinician_attested",
      resolvedByMembershipId: MEM,
      resolvedAt: "2026-03-05T19:00:00.000Z",
    },
  };
  const openBracket: EvvBracketDto = {
    visitId: "vis-open",
    checkInEvent: { ...checkIn, visitId: "vis-open" },
    checkOutEvent: null,
    bracketState: "missing_open",
    missingResolution: null,
  };
  const submission: EvvAggregatorSubmissionDto = {
    id: "sub-1",
    visitId: "vis-present",
    stateCode: "TX",
    aggregatorVendor: "sandata",
    status: "accepted",
    aggregatorTransactionId: "txn-abc",
    attemptCount: 1,
  };
  const pendingSubmission: EvvAggregatorSubmissionDto = {
    id: "sub-2",
    visitId: "vis-doc",
    stateCode: "TX",
    aggregatorVendor: "sandata",
    status: "queued",
    aggregatorTransactionId: null,
    attemptCount: 0,
  };
  const location: EvvLocationDto = {
    membershipId: MEM,
    eventId: "evt-in",
    visitId: "vis-present",
    lat: 30.2672,
    lng: -97.7431,
    accuracyM: 8,
    capturedAt: "2026-03-05T14:01:00.000Z",
  };
  return {
    brackets: [
      { visitId: "vis-present", bracket: presentBracket },
      { visitId: "vis-doc", bracket: documentedBracket },
      { visitId: "vis-open", bracket: openBracket },
    ],
    submissions: [
      { visitId: "vis-present", submission },
      { visitId: "vis-doc", submission: pendingSubmission },
    ],
    locations: [location],
    arrivals: [
      {
        visitId: "vis-present",
        arrival: {
          arrivedAt: "2026-03-05T14:01:00.000Z",
          clinicianFirstName: "Sarah",
          discipline: "rn",
        },
      },
    ],
    verificationSummaries: [
      {
        visitId: "vis-present",
        summary: {
          arrivedAt: "2026-03-05T14:01:00.000Z",
          departedAt: "2026-03-05T15:02:00.000Z",
          durationMinutes: 61,
        },
      },
    ],
    complianceWindows: [
      {
        window: WINDOW,
        counts: {
          compliant: 8,
          documentedMissing: 1,
          unresolvedMissing: 1,
          notRequired: 0,
          total: 10,
        },
      },
    ],
    metricWindows: [
      {
        window: WINDOW,
        counts: {
          lateCheckoutVisits: 2,
          totalVisits: 10,
          geofenceDeviationEvents: 3,
          suspectedSpoofEvents: 1,
          totalEvents: 20,
        },
      },
    ],
    aggregatorWindows: [
      { window: WINDOW, counts: { accepted: 9, total: 10 } },
      { window: WINDOW, stateCode: "TX", counts: { accepted: 4, total: 5 } },
    ],
    deviceCoverage: { totalActiveClinicians: 12, cliniciansWithApprovedDevice: 10 },
  };
}

describe("EvvBracketResolver (§4.3, published over M8's resolveBracket contract — M8 D9)", () => {
  const resolver = () => createEvvBracketResolver(createInMemoryEvvSeamStore(seed()).store);

  it("present bracket → evv_present with authoritative check-in/out instants + event ids", async () => {
    expect(
      await resolver().resolveBracket({ organizationId: ORG, visitId: "vis-present" }),
    ).toEqual({
      checkInEventId: "evt-in",
      checkOutEventId: "evt-out",
      startedAt: "2026-03-05T14:01:00.000Z",
      endedAt: "2026-03-05T15:02:00.000Z",
      bracketState: "evv_present",
    });
  });

  it("documented-missing bracket → evv_missing_documented with whatever event ids exist", async () => {
    expect(await resolver().resolveBracket({ organizationId: ORG, visitId: "vis-doc" })).toEqual({
      checkInEventId: "evt-in",
      checkOutEventId: null,
      startedAt: "2026-03-05T14:01:00.000Z",
      endedAt: null,
      bracketState: "evv_missing_documented",
    });
  });

  it("missing_open and absent → null so M8's evv_missing_reason fallback path owns it", async () => {
    expect(
      await resolver().resolveBracket({ organizationId: ORG, visitId: "vis-open" }),
    ).toBeNull();
    expect(
      await resolver().resolveBracket({ organizationId: ORG, visitId: "vis-none" }),
    ).toBeNull();
  });
});

describe("EvvComplianceReader (§4.3, ADR-0008 — only unresolved_missing blocks billing)", () => {
  const reader = () => createEvvComplianceReader(createInMemoryEvvSeamStore(seed()).store);

  it("bracketStateForVisit maps the bracket to the 4-state billing verdict", async () => {
    expect(await reader().bracketStateForVisit(ORG, "vis-present")).toBe("compliant");
    expect(await reader().bracketStateForVisit(ORG, "vis-doc")).toBe("documented_missing");
    expect(await reader().bracketStateForVisit(ORG, "vis-open")).toBe("unresolved_missing");
    // no bracket placeholder at all → no EVV path (open-model / non-EVV service) → not_required.
    expect(await reader().bracketStateForVisit(ORG, "vis-none")).toBe("not_required");
  });

  it("complianceRateForWindow passes the breakdown through", async () => {
    expect(await reader().complianceRateForWindow(ORG, WINDOW)).toEqual({
      compliant: 8,
      documentedMissing: 1,
      unresolvedMissing: 1,
      notRequired: 0,
      total: 10,
    });
  });
});

describe("EvvAggregatorReferenceReader (§4.3)", () => {
  const reader = () => createEvvAggregatorReferenceReader(createInMemoryEvvSeamStore(seed()).store);

  it("aggregatorIdForVisit returns the txn id only once a submission has one", async () => {
    expect(await reader().aggregatorIdForVisit(ORG, "vis-present")).toEqual({
      aggregatorTransactionId: "txn-abc",
      stateCode: "TX",
      aggregatorVendor: "sandata",
    });
    // queued submission with no txn id yet → null.
    expect(await reader().aggregatorIdForVisit(ORG, "vis-doc")).toBeNull();
    expect(await reader().aggregatorIdForVisit(ORG, "vis-none")).toBeNull();
  });

  it("submissionForVisit returns the full submission row (M25 denial back-link)", async () => {
    expect((await reader().submissionForVisit(ORG, "vis-doc"))?.status).toBe("queued");
    expect(await reader().submissionForVisit(ORG, "vis-none")).toBeNull();
  });
});

describe("EvvLocationProvider (§4.3, the only coordinate-bearing seam — D10)", () => {
  const provider = () => createEvvLocationProvider(createInMemoryEvvSeamStore(seed()).store);

  it("lastKnownLocationForClinician returns the coordinate; null for an unknown clinician", async () => {
    expect((await provider().lastKnownLocationForClinician(ORG, MEM))?.eventId).toBe("evt-in");
    expect(await provider().lastKnownLocationForClinician(ORG, "mem-x")).toBeNull();
  });

  it("lastKnownLocationsForOrgShift returns the roster of last-known coordinates", async () => {
    expect(await provider().lastKnownLocationsForOrgShift(ORG)).toHaveLength(1);
  });
});

describe("EvvMetricsProvider (§4.3)", () => {
  const provider = () => createEvvMetricsProvider(createInMemoryEvvSeamStore(seed()).store);

  it("getComplianceRate = compliant ÷ total (reuses the EvvComplianceDto breakdown)", async () => {
    expect(await provider().getComplianceRate(ORG, WINDOW)).toBe(8 / 10);
  });

  it("late-checkout = per-visit; geofence-deviation + spoofing = per-event", async () => {
    expect(await provider().getLateCheckoutRate(ORG, WINDOW)).toBe(2 / 10);
    expect(await provider().getGeofenceDeviationRate(ORG, WINDOW)).toBe(3 / 20);
    expect(await provider().getGpsSpoofingDetectedRate(ORG, WINDOW)).toBe(1 / 20);
  });

  it("aggregator success rate divides accepted ÷ total, narrowable by state", async () => {
    expect(await provider().getAggregatorSubmissionSuccessRate(ORG, WINDOW)).toBe(9 / 10);
    expect(
      await provider().getAggregatorSubmissionSuccessRate(ORG, WINDOW, { stateCode: "TX" }),
    ).toBe(4 / 5);
  });

  it("getDeviceRegistrationCoverage passes the snapshot through", async () => {
    expect(await provider().getDeviceRegistrationCoverage(ORG)).toEqual({
      totalActiveClinicians: 12,
      cliniciansWithApprovedDevice: 10,
    });
  });

  it("vacuous window: compliance + aggregator-success are 1, bad-event rates are 0", async () => {
    const empty = createEvvMetricsProvider(createInMemoryEvvSeamStore().store);
    const noData = { from: "2030-01-01T00:00:00.000Z", to: "2030-02-01T00:00:00.000Z" };
    expect(await empty.getComplianceRate(ORG, noData)).toBe(1);
    expect(await empty.getAggregatorSubmissionSuccessRate(ORG, noData)).toBe(1);
    expect(await empty.getLateCheckoutRate(ORG, noData)).toBe(0);
    expect(await empty.getGeofenceDeviationRate(ORG, noData)).toBe(0);
    expect(await empty.getGpsSpoofingDetectedRate(ORG, noData)).toBe(0);
  });
});

describe("EvvVerificationProvider (§4.3, timestamp only — no coordinates)", () => {
  const provider = () => createEvvVerificationProvider(createInMemoryEvvSeamStore(seed()).store);

  it("arrivalEventForVisit returns the lay arrival; the shape carries NO coordinates", async () => {
    const arrival = await provider().arrivalEventForVisit(ORG, "vis-present");
    expect(arrival).toEqual({
      arrivedAt: "2026-03-05T14:01:00.000Z",
      clinicianFirstName: "Sarah",
      discipline: "rn",
    });
    expect(Object.keys(arrival ?? {})).not.toContain("lat");
    expect(await provider().arrivalEventForVisit(ORG, "vis-none")).toBeNull();
  });

  it("visitVerificationSummaryForPortal returns the post-visit summary", async () => {
    expect(await provider().visitVerificationSummaryForPortal(ORG, "vis-present")).toEqual({
      arrivedAt: "2026-03-05T14:01:00.000Z",
      departedAt: "2026-03-05T15:02:00.000Z",
      durationMinutes: 61,
    });
  });
});

describe("boot wiring (registerEvvSeams)", () => {
  afterEach(() => __resetSeamsForTest());

  it("registers all six seams so validateSeams passes and they resolve as real impls", async () => {
    registerEvvSeams({ store: createInMemoryEvvSeamStore(seed()).store });
    expect(() => validateSeams()).not.toThrow();
    expect(
      (
        await getSeam("EvvBracketResolver").resolveBracket({
          organizationId: ORG,
          visitId: "vis-present",
        })
      )?.bracketState,
    ).toBe("evv_present");
    expect(await getSeam("EvvComplianceReader").bracketStateForVisit(ORG, "vis-open")).toBe(
      "unresolved_missing",
    );
    expect(
      (await getSeam("EvvAggregatorReferenceReader").submissionForVisit(ORG, "vis-doc"))?.status,
    ).toBe("queued");
    expect(
      (await getSeam("EvvLocationProvider").lastKnownLocationForClinician(ORG, MEM))?.eventId,
    ).toBe("evt-in");
    expect(await getSeam("EvvMetricsProvider").getComplianceRate(ORG, WINDOW)).toBe(8 / 10);
    expect(
      (await getSeam("EvvVerificationProvider").arrivalEventForVisit(ORG, "vis-present"))
        ?.clinicianFirstName,
    ).toBe("Sarah");
  });

  it("falls back to fail-closed deny-stubs when M18 does not register", () => {
    validateSeams();
    expect(() =>
      getSeam("EvvBracketResolver").resolveBracket({ organizationId: ORG, visitId: "vis-1" }),
    ).toThrow(/not implemented/);
    expect(() => getSeam("EvvComplianceReader").bracketStateForVisit(ORG, "vis-1")).toThrow(
      /not implemented/,
    );
    expect(() => getSeam("EvvAggregatorReferenceReader").submissionForVisit(ORG, "vis-1")).toThrow(
      /not implemented/,
    );
    expect(() => getSeam("EvvLocationProvider").lastKnownLocationForClinician(ORG, MEM)).toThrow(
      /not implemented/,
    );
    expect(() => getSeam("EvvMetricsProvider").getComplianceRate(ORG, WINDOW)).toThrow(
      /not implemented/,
    );
    expect(() => getSeam("EvvVerificationProvider").arrivalEventForVisit(ORG, "vis-1")).toThrow(
      /not implemented/,
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  type SignedChcEncounterFact,
  resolveSignedChcClinicalQuantity,
} from "./chc-clinical-quantity";

const scope = {
  organizationId: "11111111-1111-1111-1111-111111111111",
  providerEntityId: "22222222-2222-2222-2222-222222222222",
  patientId: "33333333-3333-3333-3333-333333333333",
  admissionId: "44444444-4444-4444-4444-444444444444",
  serviceFrom: "2026-11-01",
  serviceTo: "2026-11-01",
  serviceTimeZone: "America/Los_Angeles",
  assessedAt: "2026-11-04T00:00:00.000Z",
  chcServiceDates: ["2026-11-01"],
} as const;

const encounter = (overrides: Partial<SignedChcEncounterFact> = {}): SignedChcEncounterFact => ({
  ...scope,
  encounterId: "55555555-5555-4555-8555-555555555555",
  serviceDate: "2026-11-01",
  status: "signed",
  signedAt: "2026-11-02T01:00:00.000Z",
  startedAt: "2026-11-01T17:00:00.000Z",
  endedAt: "2026-11-01T21:00:00.000Z",
  timeSource: "clinician",
  sourceVersion: 3,
  discipline: "rn",
  locationId: "77777777-7777-4777-8777-777777777777",
  ...overrides,
});

describe("M8-backed CHC actual clinical interval normalization", () => {
  it("aggregates exact signed minutes by the authoritative local service date", () => {
    expect(resolveSignedChcClinicalQuantity({ ...scope, encounters: [encounter()] })).toMatchObject(
      {
        status: "observed",
        payerEligibility: "unresolved",
        institutionalUnits: "unqualified",
        days: [
          {
            serviceDate: "2026-11-01",
            actualClinicalMinutes: 240,
            sourceEncounters: [{ encounterId: encounter().encounterId, sourceVersion: 3 }],
          },
        ],
      },
    );
  });

  it("splits a cross-midnight interval at local midnight across a daylight-saving boundary", () => {
    const serviceWindow = {
      ...scope,
      serviceFrom: "2026-03-07",
      serviceTo: "2026-03-08",
      chcServiceDates: ["2026-03-07", "2026-03-08"],
    };
    const crossMidnight = encounter({
      serviceDate: "2026-03-07",
      signedAt: "2026-03-08T11:00:00.000Z",
      startedAt: "2026-03-08T07:30:00.000Z",
      endedAt: "2026-03-08T10:30:00.000Z",
    });
    expect(
      resolveSignedChcClinicalQuantity({ ...serviceWindow, encounters: [crossMidnight] }),
    ).toMatchObject({
      status: "observed",
      days: [
        { serviceDate: "2026-03-07", actualClinicalMinutes: 30 },
        { serviceDate: "2026-03-08", actualClinicalMinutes: 150 },
      ],
    });
  });

  it("refuses missing, unsigned, imprecise, out-of-scope and duplicate source facts", () => {
    expect(
      resolveSignedChcClinicalQuantity({ ...scope, encounters: [encounter({ endedAt: null })] }),
    ).toMatchObject({
      status: "unresolved",
      reasonCode: "CHC_ACTUAL_INTERVAL_EVIDENCE_INCOMPLETE",
    });
    expect(
      resolveSignedChcClinicalQuantity({ ...scope, encounters: [encounter({ status: "draft" })] }),
    ).toMatchObject({ status: "unresolved", reasonCode: "CHC_ENCOUNTER_NOT_SIGNED" });
    expect(
      resolveSignedChcClinicalQuantity({
        ...scope,
        encounters: [encounter({ startedAt: "2026-11-01T17:00:01.000Z" })],
      }),
    ).toMatchObject({ status: "unresolved", reasonCode: "CHC_ACTUAL_INTERVAL_INVALID" });
    expect(
      resolveSignedChcClinicalQuantity({
        ...scope,
        encounters: [encounter({ providerEntityId: "99999999-9999-4999-8999-999999999999" })],
      }),
    ).toMatchObject({ status: "unresolved", reasonCode: "CHC_ENCOUNTER_SCOPE_MISMATCH" });
    expect(
      resolveSignedChcClinicalQuantity({ ...scope, encounters: [encounter(), encounter()] }),
    ).toMatchObject({ status: "ambiguous", reasonCode: "CHC_DUPLICATE_ENCOUNTER_SOURCE" });
  });

  it("refuses overlapping care intervals and service outside a CHC LOC day", () => {
    const first = encounter();
    const second = encounter({
      encounterId: "66666666-6666-4666-8666-666666666666",
      startedAt: "2026-11-01T20:00:00.000Z",
      endedAt: "2026-11-01T22:00:00.000Z",
    });
    expect(
      resolveSignedChcClinicalQuantity({ ...scope, encounters: [first, second] }),
    ).toMatchObject({
      status: "ambiguous",
      reasonCode: "CHC_OVERLAPPING_CARE_INTERVALS_UNQUALIFIED",
    });
    expect(
      resolveSignedChcClinicalQuantity({
        ...scope,
        chcServiceDates: [],
        encounters: [first],
      }),
    ).toMatchObject({ status: "unresolved", reasonCode: "CHC_SERVICE_WINDOW_OR_LOC_INVALID" });
  });

  it("keeps observed time separate from payer eligibility and transmission units", () => {
    const result = resolveSignedChcClinicalQuantity({ ...scope, encounters: [encounter()] });
    expect(result.status).toBe("observed");
    if (result.status === "observed") {
      expect(result.payerEligibility).toBe("unresolved");
      expect(result.institutionalUnits).toBe("unqualified");
      expect(result.days[0]?.actualClinicalMinutes).toBe(240);
      expect(result.days[0]).not.toHaveProperty("units");
    }
  });

  it("requires the final co-sign attestation for a cosigned encounter", () => {
    const cosigned = encounter({
      status: "cosigned",
      signedAt: "2026-11-02T01:00:00.000Z",
      cosignedAt: "2026-11-02T02:00:00.000Z",
    });
    expect(resolveSignedChcClinicalQuantity({ ...scope, encounters: [cosigned] })).toMatchObject({
      status: "observed",
      days: [{ actualClinicalMinutes: 240 }],
    });
    expect(
      resolveSignedChcClinicalQuantity({
        ...scope,
        encounters: [encounter({ status: "cosigned", cosignedAt: null })],
      }),
    ).toMatchObject({
      status: "unresolved",
      reasonCode: "CHC_ACTUAL_INTERVAL_EVIDENCE_INCOMPLETE",
    });
    expect(
      resolveSignedChcClinicalQuantity({
        ...scope,
        assessedAt: "2026-11-02T01:30:00.000Z",
        encounters: [cosigned],
      }),
    ).toMatchObject({
      status: "unresolved",
      reasonCode: "CHC_ACTUAL_INTERVAL_EVIDENCE_INCOMPLETE",
    });
  });

  it("clips a carry-in encounter to the requested local day and accepts the actual 25-hour day bound", () => {
    const carryIn = encounter({
      serviceDate: "2026-10-31",
      startedAt: "2026-11-01T06:30:00.000Z",
      endedAt: "2026-11-01T08:30:00.000Z",
      signedAt: "2026-11-02T01:00:00.000Z",
    });
    expect(resolveSignedChcClinicalQuantity({ ...scope, encounters: [carryIn] })).toMatchObject({
      status: "observed",
      days: [{ actualClinicalMinutes: 90 }],
    });

    const fallBackDay = {
      ...scope,
      serviceFrom: "2026-11-01",
      serviceTo: "2026-11-01",
      serviceTimeZone: "America/Los_Angeles",
      chcServiceDates: ["2026-11-01"],
      assessedAt: "2026-11-03T00:00:00.000Z",
    };
    const fullPhysicalDay = encounter({
      startedAt: "2026-11-01T07:00:00.000Z",
      endedAt: "2026-11-02T08:00:00.000Z",
      signedAt: "2026-11-02T08:01:00.000Z",
    });
    expect(
      resolveSignedChcClinicalQuantity({ ...fallBackDay, encounters: [fullPhysicalDay] }),
    ).toMatchObject({ status: "observed", days: [{ actualClinicalMinutes: 1500 }] });

    const springForwardDay = {
      ...fallBackDay,
      serviceFrom: "2026-03-08",
      serviceTo: "2026-03-08",
      chcServiceDates: ["2026-03-08"],
      assessedAt: "2026-03-10T00:00:00.000Z",
    };
    const fullShortDay = encounter({
      serviceDate: "2026-03-08",
      startedAt: "2026-03-08T08:00:00.000Z",
      endedAt: "2026-03-09T07:00:00.000Z",
      signedAt: "2026-03-09T08:00:00.000Z",
    });
    expect(
      resolveSignedChcClinicalQuantity({ ...springForwardDay, encounters: [fullShortDay] }),
    ).toMatchObject({ status: "observed", days: [{ actualClinicalMinutes: 1380 }] });
  });

  it("rejects signatures made after the fixed assessment instant", () => {
    expect(
      resolveSignedChcClinicalQuantity({
        ...scope,
        assessedAt: "2026-11-01T22:00:00.000Z",
        encounters: [encounter({ signedAt: "2026-11-02T01:00:00.000Z" })],
      }),
    ).toMatchObject({
      status: "unresolved",
      reasonCode: "CHC_ACTUAL_INTERVAL_EVIDENCE_INCOMPLETE",
    });
  });
});

describe("CHC actual interval refusals and local-day clipping", () => {
  it("refuses a voided encounter and accepts the same encounter with no void marker", () => {
    const voided = resolveSignedChcClinicalQuantity({
      ...scope,
      encounters: [encounter({ voidedAt: "2026-11-02T02:00:00.000Z" })],
    });
    const notVoided = resolveSignedChcClinicalQuantity({
      ...scope,
      encounters: [encounter({ voidedAt: null })],
    });

    expect(voided).toEqual({
      status: "unresolved",
      reasonCode: "CHC_ACTUAL_INTERVAL_EVIDENCE_INCOMPLETE",
    });
    expect(notVoided.status).toBe("observed");
  });

  it("refuses an encounter signed before its care interval ended, but accepts a signature at the end", () => {
    // The interval ends at 21:00Z; a signature at 20:00Z attests to care that had not finished.
    const signedEarly = resolveSignedChcClinicalQuantity({
      ...scope,
      encounters: [encounter({ signedAt: "2026-11-01T20:00:00.000Z" })],
    });
    const signedAtEnd = resolveSignedChcClinicalQuantity({
      ...scope,
      encounters: [encounter({ signedAt: "2026-11-01T21:00:00.000Z" })],
    });

    expect(signedEarly).toEqual({
      status: "unresolved",
      reasonCode: "CHC_SOURCE_SERVICE_DATE_MISMATCH",
    });
    expect(signedAtEnd).toMatchObject({
      status: "observed",
      days: [{ actualClinicalMinutes: 240 }],
    });
  });

  it("refuses a cosigned encounter whose final attestation precedes the interval end", () => {
    const result = resolveSignedChcClinicalQuantity({
      ...scope,
      encounters: [
        encounter({
          status: "cosigned",
          signedAt: "2026-11-02T01:00:00.000Z",
          cosignedAt: "2026-11-01T20:00:00.000Z",
        }),
      ],
    });

    expect(result).toEqual({
      status: "unresolved",
      reasonCode: "CHC_SOURCE_SERVICE_DATE_MISMATCH",
    });
  });
});

describe("CHC overnight intervals are split by the local service day, not by UTC", () => {
  // 2026-06-10 is PDT (UTC-7): 22:00 local on the 10th to 02:00 local on the 11th.
  const overnight = encounter({
    serviceDate: "2026-06-10",
    startedAt: "2026-06-11T05:00:00.000Z",
    endedAt: "2026-06-11T09:00:00.000Z",
    signedAt: "2026-06-11T10:00:00.000Z",
  });
  const juneWindow = {
    ...scope,
    serviceFrom: "2026-06-10",
    serviceTo: "2026-06-10",
    chcServiceDates: ["2026-06-10"],
    assessedAt: "2026-06-12T00:00:00.000Z",
  };

  it("clips an overnight interval to the single requested local day", () => {
    const result = resolveSignedChcClinicalQuantity({ ...juneWindow, encounters: [overnight] });

    expect(result).toMatchObject({
      status: "observed",
      days: [
        {
          serviceDate: "2026-06-10",
          serviceDayStart: "2026-06-10T07:00:00.000Z",
          serviceDayEnd: "2026-06-11T07:00:00.000Z",
          actualClinicalMinutes: 120,
        },
      ],
    });
  });

  it("splits an overnight interval across both local days when both are in the window", () => {
    const result = resolveSignedChcClinicalQuantity({
      ...juneWindow,
      serviceTo: "2026-06-11",
      chcServiceDates: ["2026-06-10", "2026-06-11"],
      encounters: [overnight],
    });

    expect(result).toMatchObject({
      status: "observed",
      days: [
        { serviceDate: "2026-06-10", actualClinicalMinutes: 120 },
        { serviceDate: "2026-06-11", actualClinicalMinutes: 120 },
      ],
    });
  });

  it("refuses an overnight interval that continues into a local day with no CHC level of care", () => {
    const result = resolveSignedChcClinicalQuantity({
      ...juneWindow,
      serviceTo: "2026-06-11",
      chcServiceDates: ["2026-06-10"],
      encounters: [overnight],
    });

    expect(result).toEqual({ status: "unresolved", reasonCode: "CHC_LOC_PERIOD_MISMATCH" });
  });
});

describe("CHC daily minutes never exceed the length of the local day", () => {
  const juneWindow = {
    ...scope,
    serviceFrom: "2026-06-10",
    serviceTo: "2026-06-10",
    chcServiceDates: ["2026-06-10"],
    assessedAt: "2026-06-13T00:00:00.000Z",
  };

  it("accepts a single interval that fills the whole 1440-minute local day", () => {
    const fullDay = encounter({
      serviceDate: "2026-06-10",
      startedAt: "2026-06-10T07:00:00.000Z",
      endedAt: "2026-06-11T07:00:00.000Z",
      signedAt: "2026-06-11T08:00:00.000Z",
    });

    const result = resolveSignedChcClinicalQuantity({ ...juneWindow, encounters: [fullDay] });

    expect(result).toMatchObject({ status: "observed", days: [{ actualClinicalMinutes: 1440 }] });
  });

  it("sums back-to-back encounters to 1440 minutes without calling them overlapping", () => {
    const morning = encounter({
      serviceDate: "2026-06-10",
      startedAt: "2026-06-10T07:00:00.000Z",
      endedAt: "2026-06-10T19:00:00.000Z",
      signedAt: "2026-06-10T20:00:00.000Z",
    });
    const evening = encounter({
      encounterId: "66666666-6666-4666-8666-666666666666",
      serviceDate: "2026-06-10",
      startedAt: "2026-06-10T19:00:00.000Z",
      endedAt: "2026-06-11T07:00:00.000Z",
      signedAt: "2026-06-11T08:00:00.000Z",
    });

    const result = resolveSignedChcClinicalQuantity({
      ...juneWindow,
      encounters: [evening, morning],
    });

    expect(result).toMatchObject({ status: "observed", days: [{ actualClinicalMinutes: 1440 }] });
    if (result.status === "observed") {
      expect(result.days[0]?.sourceEncounters.map((source) => source.encounterId)).toEqual([
        morning.encounterId,
        evening.encounterId,
      ]);
    }
  });

  it("caps each local day of a multi-day encounter at its own length", () => {
    // 12:00 local on the 10th to 12:00 local on the 12th: a half day, a full day, a half day.
    const threeDays = encounter({
      serviceDate: "2026-06-10",
      startedAt: "2026-06-10T19:00:00.000Z",
      endedAt: "2026-06-12T19:00:00.000Z",
      signedAt: "2026-06-12T20:00:00.000Z",
    });

    const result = resolveSignedChcClinicalQuantity({
      ...juneWindow,
      serviceTo: "2026-06-12",
      chcServiceDates: ["2026-06-10", "2026-06-11", "2026-06-12"],
      encounters: [threeDays],
    });

    expect(result).toMatchObject({
      status: "observed",
      days: [
        { serviceDate: "2026-06-10", actualClinicalMinutes: 720 },
        { serviceDate: "2026-06-11", actualClinicalMinutes: 1440 },
        { serviceDate: "2026-06-12", actualClinicalMinutes: 720 },
      ],
    });
  });
});

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

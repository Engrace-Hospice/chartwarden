import { describe, expect, it } from "vitest";
import type { MedicaidElectionHistoryFacts } from "../../06-admission/seams/medicaid-election-history";
import {
  SUPPORTED_SYNTHETIC_ELECTION_DAY_BASIS,
  resolveRhcElectionDayRange,
} from "./rhc-election-day";

const history: MedicaidElectionHistoryFacts = {
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  providerEntityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  patientId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  admissionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  admissionVersion: 1,
  transferredIn: false,
  admissionState: "active",
  historyTruncated: false,
  historyEvidence: {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    electionPeriodId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    coverageFrom: "2026-09-30",
    coverageThrough: "2026-12-31",
    completenessStatus: "complete",
    priorHospiceStatus: "none_confirmed",
    transferStatus: "none_confirmed",
    interruptionStatus: "none_confirmed",
    sourceReference: "evidence:synthetic-election-history/source-1",
    sourceVersion: 1,
    verificationStatus: "verified",
    verifiedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  electionPeriods: [
    {
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      sequenceNumber: 1,
      status: "active",
      effectiveAt: "2026-09-30",
      actualEndAt: null,
      electionStatementId: "99999999-9999-4999-8999-999999999999",
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      statement: {
        id: "99999999-9999-4999-8999-999999999999",
        status: "signed",
        patientId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        providerEntityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        declaredEffectiveDate: "2026-09-30",
        signedAt: "2026-01-01",
        version: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  ],
  transfers: [],
  revocations: [],
  completedDischarges: [],
};

const rates = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    version: 1,
    serviceCategory: "RHC" as const,
    bucketFrom: 1,
    bucketTo: 60,
    electionDayBasis: SUPPORTED_SYNTHETIC_ELECTION_DAY_BASIS,
    verificationStatus: "verified" as const,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    sourceDocumentRef: "doc:synthetic-rate/day-1-60",
    verifiedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    version: 1,
    serviceCategory: "RHC" as const,
    bucketFrom: 61,
    bucketTo: null,
    electionDayBasis: SUPPORTED_SYNTHETIC_ELECTION_DAY_BASIS,
    verificationStatus: "verified" as const,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    sourceDocumentRef: "doc:synthetic-rate/day-61-plus",
    verifiedAt: "2026-01-01T00:00:00.000Z",
  },
];

const scope = {
  history,
  rateRows: rates,
  organizationId: history.organizationId,
  providerEntityId: history.providerEntityId,
  patientId: history.patientId,
  admissionId: history.admissionId,
  admissionVersion: history.admissionVersion,
  programKind: "managed_care" as const,
  serviceFrom: "2026-11-26",
  serviceTo: "2026-12-02",
  assessedAt: "2026-11-26T12:00:00.000Z",
};

describe("resolveRhcElectionDayRange", () => {
  it("resolves exact calendar days 58–64 across the day-60/day-61 boundary", () => {
    const result = resolveRhcElectionDayRange(scope);
    expect(result.status).toBe("resolved");
    expect(result.snapshot).toMatchObject({ dayFrom: 58, dayTo: 64 });
    expect(result.days.get("2026-11-26")?.electionDayNumber).toBe(58);
    expect(result.days.get("2026-11-29")?.electionDayNumber).toBe(61);
    expect(result.days.get("2026-12-02")?.electionDayNumber).toBe(64);
    expect(result.days.size).toBe(7);
  });

  it("holds when completeness is absent, truncated, future-known, or conflicts with scope", () => {
    expect(resolveRhcElectionDayRange({ ...scope, history: null }).reasonCode).toBe(
      "RHC_ELECTION_HISTORY_UNAVAILABLE",
    );
    expect(
      resolveRhcElectionDayRange({ ...scope, history: { ...history, historyTruncated: true } })
        .reasonCode,
    ).toBe("RHC_ELECTION_HISTORY_COMPLETENESS_UNVERIFIED");
    expect(
      resolveRhcElectionDayRange({
        ...scope,
        history: {
          ...history,
          historyEvidence: {
            ...history.historyEvidence!,
            verifiedAt: "2027-01-01T00:00:00.000Z",
          },
        },
      }).reasonCode,
    ).toBe("RHC_ELECTION_HISTORY_COMPLETENESS_UNVERIFIED");
  });

  it("does not borrow a transfer or later election policy", () => {
    const transferred = {
      ...history,
      transfers: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          direction: "in" as const,
          effectiveAt: "2026-10-01",
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    expect(resolveRhcElectionDayRange({ ...scope, history: transferred }).status).toBe(
      "unsupported",
    );
    expect(
      resolveRhcElectionDayRange({
        ...scope,
        history: {
          ...history,
          electionPeriods: [
            ...history.electionPeriods,
            {
              ...history.electionPeriods[0]!,
              id: "44444444-4444-4444-8444-444444444444",
              sequenceNumber: 2,
              effectiveAt: "2026-12-01",
            },
          ],
        },
      }).reasonCode,
    ).toBe("RHC_SUBSEQUENT_ELECTION_DAY_BASIS_UNQUALIFIED");
  });
});

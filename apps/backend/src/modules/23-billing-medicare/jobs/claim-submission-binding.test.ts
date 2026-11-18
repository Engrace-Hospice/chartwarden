import { describe, expect, it } from "vitest";
import { claimSubmissionBindingMatches, persistedRetryAttempt } from "./m23-jobs";

const ORG = "10000000-0000-4000-8000-000000000001";
const CONFIG = "20000000-0000-4000-8000-000000000002";
const FINGERPRINT = "a".repeat(64);
const ROUTE = "b".repeat(64);

function txFor(rows: readonly Record<string, unknown>[]) {
  const query = {
    from: () => query,
    where: () => query,
    limit: async () => rows,
  };
  return { select: () => query };
}

const submission: Parameters<typeof claimSubmissionBindingMatches>[1] = {
  organizationId: ORG,
  clearinghouseVendor: "stedi",
  clearinghouseAccountReference: "tenant-account-1",
  clearinghouseMode: "test",
  clearinghouseConfigId: CONFIG,
  clearinghouseConfigVersion: 4,
  clearinghouseCredentialFingerprint: FINGERPRINT,
  expectedRouteFingerprint: ROUTE,
} as never;
const transport = { binding: { vendor: "stedi" } } as never;
const config = {
  id: CONFIG,
  organizationId: ORG,
  vendor: "stedi",
  mode: "test",
  status: "active",
  version: 4,
  credentialFingerprint: FINGERPRINT,
  baaRevokedAt: null,
};

describe("claim submission routing binding", () => {
  it("accepts only the same active tenant configuration revision and credential fingerprint", async () => {
    await expect(
      claimSubmissionBindingMatches(txFor([config]) as never, submission, transport),
    ).resolves.toBe(true);
    await expect(
      claimSubmissionBindingMatches(
        txFor([{ ...config, version: 5 }]) as never,
        submission,
        transport,
      ),
    ).resolves.toBe(false);
    await expect(
      claimSubmissionBindingMatches(
        txFor([{ ...config, credentialFingerprint: "c".repeat(64) }]) as never,
        submission,
        transport,
      ),
    ).resolves.toBe(false);
    await expect(
      claimSubmissionBindingMatches(
        txFor([{ ...config, status: "inactive" }]) as never,
        submission,
        transport,
      ),
    ).resolves.toBe(false);
    await expect(
      claimSubmissionBindingMatches(
        txFor([{ ...config, baaRevokedAt: new Date() }]) as never,
        submission,
        transport,
      ),
    ).resolves.toBe(false);
    await expect(
      claimSubmissionBindingMatches(txFor([config]) as never, submission, {
        binding: { vendor: "claimmd" },
      } as never),
    ).resolves.toBe(false);
  });

  it("accepts a platform fallback only while no tenant configuration row exists", async () => {
    const fallback = {
      ...submission,
      clearinghouseConfigId: null,
      clearinghouseConfigVersion: null,
      clearinghouseCredentialFingerprint: null,
    } as never;
    await expect(
      claimSubmissionBindingMatches(txFor([]) as never, fallback, transport),
    ).resolves.toBe(true);
    await expect(
      claimSubmissionBindingMatches(txFor([config]) as never, fallback, transport),
    ).resolves.toBe(false);
  });
});

describe("claim retry identity", () => {
  it("uses the persisted winner when an idempotent append loses a concurrent race", () => {
    expect(
      persistedRetryAttempt({
        id: "30000000-0000-4000-8000-000000000003",
        claimControlNumber: "PERSISTED-CCN",
        externalPatientControlNumber: "PERSISTED-PCN",
        attemptIndex: 2,
        dispatchState: "pending",
        outcome: "queued",
      }),
    ).toEqual({
      claimControlNumber: "PERSISTED-CCN",
      externalPatientControlNumber: "PERSISTED-PCN",
      attemptIndex: 2,
      submissionId: "30000000-0000-4000-8000-000000000003",
    });
  });

  it("refuses a persisted retry without an external patient control number", () => {
    expect(() =>
      persistedRetryAttempt({
        id: "30000000-0000-4000-8000-000000000003",
        claimControlNumber: "PERSISTED-CCN",
        externalPatientControlNumber: null,
        attemptIndex: 2,
        dispatchState: "pending",
        outcome: "queued",
      }),
    ).toThrow("persisted retry has no external patient control number");
  });
});

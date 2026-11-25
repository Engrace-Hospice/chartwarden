import { describe, expect, it } from "vitest";
import {
  type BillingEvidenceLineageFact,
  resolveBillingEvidenceLineage,
} from "./billing-evidence-lineage";

const ASSESSED = "2026-11-10T12:00:00.000Z";
const base = (overrides: Partial<BillingEvidenceLineageFact> = {}): BillingEvidenceLineageFact => ({
  id: "evidence-a",
  supersedesId: null,
  verificationStatus: "verified",
  createdAt: "2026-11-01T00:00:00.000Z",
  verifiedAt: "2026-11-01T01:00:00.000Z",
  effectiveFrom: "2026-11-01",
  effectiveTo: "2026-11-10",
  ...overrides,
});

const resolve = (
  rows: readonly BillingEvidenceLineageFact[],
  from = "2026-11-01",
  to = "2026-11-10",
) =>
  resolveBillingEvidenceLineage({ rows, serviceFrom: from, serviceTo: to, assessedAt: ASSESSED });

describe("assessment-time hospice billing evidence lineage", () => {
  it("rejects impossible service dates instead of allowing JavaScript date rollover", () => {
    expect(resolve([base()], "2026-02-30", "2026-03-01")).toEqual({
      status: "unresolved",
      reasonCode: "BILLING_EVIDENCE_ASSESSMENT_TIME_INVALID",
    });
  });

  it("refuses a partial overlap concealed by a full-window row", () => {
    const fullWindow = base();
    const conflictingNarrowRow = base({
      id: "evidence-b",
      effectiveFrom: "2026-11-05",
      effectiveTo: "2026-11-07",
    });
    expect(resolve([fullWindow, conflictingNarrowRow])).toEqual({
      status: "ambiguous",
      reasonCode: "BILLING_EVIDENCE_OVERLAPPING_HEADS",
    });
  });

  it("returns a segmentation requirement for adjacent, complete evidence periods", () => {
    const first = base({ id: "evidence-a", effectiveTo: "2026-11-05" });
    const second = base({
      id: "evidence-b",
      effectiveFrom: "2026-11-06",
      effectiveTo: "2026-11-10",
    });
    expect(resolve([first, second])).toMatchObject({ status: "segmentation_required" });
  });

  it("preserves a real gap instead of extending either evidence period", () => {
    const first = base({ id: "evidence-a", effectiveTo: "2026-11-04" });
    const second = base({
      id: "evidence-b",
      effectiveFrom: "2026-11-06",
      effectiveTo: "2026-11-10",
    });
    expect(resolve([first, second])).toEqual({
      status: "unresolved",
      reasonCode: "BILLING_EVIDENCE_PERIOD_INCOMPLETE",
    });
  });

  it("applies a verified narrowed correction before checking requested service coverage", () => {
    const predecessor = base({ id: "evidence-a" });
    const correction = base({
      id: "evidence-b",
      supersedesId: predecessor.id,
      effectiveTo: "2026-11-05",
      createdAt: "2026-11-08T00:00:00.000Z",
      verifiedAt: "2026-11-09T00:00:00.000Z",
    });
    expect(resolve([predecessor, correction])).toEqual({
      status: "unresolved",
      reasonCode: "BILLING_EVIDENCE_PERIOD_INCOMPLETE",
    });
    expect(resolve([predecessor, correction], "2026-11-01", "2026-11-05")).toMatchObject({
      status: "verified",
      row: { id: "evidence-b" },
    });
  });

  it("does not resurrect a predecessor when a verified correction ends before the requested window", () => {
    const predecessor = base({ id: "evidence-a", effectiveTo: null });
    const correction = base({
      id: "evidence-b",
      supersedesId: predecessor.id,
      effectiveTo: "2026-11-05",
      createdAt: "2026-11-08T00:00:00.000Z",
      verifiedAt: "2026-11-09T00:00:00.000Z",
    });
    expect(resolve([predecessor, correction], "2026-11-06", "2026-11-10")).toEqual({
      status: "unresolved",
      reasonCode: "BILLING_EVIDENCE_PERIOD_INCOMPLETE",
    });
  });

  it("does not let a pending correction rewrite or verify the predecessor", () => {
    const predecessor = base({ id: "evidence-a" });
    const pending = base({
      id: "evidence-pending",
      supersedesId: predecessor.id,
      verificationStatus: "pending",
      createdAt: "2026-11-08T00:00:00.000Z",
      verifiedAt: null,
    });
    expect(resolve([predecessor, pending])).toEqual({
      status: "unresolved",
      reasonCode: "BILLING_EVIDENCE_CORRECTION_PENDING",
    });
    expect(
      resolveBillingEvidenceLineage({
        rows: [predecessor, pending],
        serviceFrom: "2026-11-01",
        serviceTo: "2026-11-10",
        assessedAt: "2026-11-07T23:59:59.999Z",
      }),
    ).toMatchObject({ status: "verified", row: { id: "evidence-a" } });

    const outOfWindowPending = {
      ...pending,
      effectiveTo: "2026-11-05",
    };
    expect(resolve([predecessor, outOfWindowPending], "2026-11-06", "2026-11-10")).toMatchObject({
      status: "verified",
      row: { id: "evidence-a" },
    });
  });

  it("does not let future-recorded or future-verified corrections alter a historical assessment", () => {
    const predecessor = base({ id: "evidence-a" });
    const futureRecorded = base({
      id: "evidence-future-recorded",
      supersedesId: predecessor.id,
      createdAt: "2026-11-11T00:00:00.000Z",
      verifiedAt: "2026-11-11T01:00:00.000Z",
    });
    const futureVerified = base({
      id: "evidence-future-verified",
      supersedesId: predecessor.id,
      createdAt: "2026-11-09T00:00:00.000Z",
      verifiedAt: "2026-11-11T01:00:00.000Z",
    });
    expect(
      resolveBillingEvidenceLineage({
        rows: [predecessor, futureRecorded, futureVerified],
        serviceFrom: "2026-11-01",
        serviceTo: "2026-11-10",
        assessedAt: ASSESSED,
      }),
    ).toMatchObject({ status: "verified", row: { id: "evidence-a" } });
  });

  it("treats a verified revocation as a hold and refuses branched correction histories", () => {
    const predecessor = base({ id: "evidence-a" });
    const revoked = base({
      id: "evidence-revoked",
      supersedesId: predecessor.id,
      verificationStatus: "revoked",
      createdAt: "2026-11-08T00:00:00.000Z",
      verifiedAt: "2026-11-09T00:00:00.000Z",
    });
    expect(resolve([predecessor, revoked])).toEqual({
      status: "unresolved",
      reasonCode: "BILLING_EVIDENCE_REVOKED",
    });

    const branchA = base({ id: "evidence-branch-a", supersedesId: predecessor.id });
    const branchB = base({ id: "evidence-branch-b", supersedesId: predecessor.id });
    expect(resolve([predecessor, branchA, branchB])).toEqual({
      status: "ambiguous",
      reasonCode: "BILLING_EVIDENCE_SUPERSESSION_BRANCH",
    });
  });

  it("resolves a pending correction once a later verified row supersedes it", () => {
    const v1 = base({ id: "evidence-v1" });
    const pending = base({
      id: "evidence-pending",
      supersedesId: v1.id,
      verificationStatus: "pending",
      createdAt: "2026-11-05T00:00:00.000Z",
      verifiedAt: null,
    });
    const v2 = base({
      id: "evidence-v2",
      supersedesId: pending.id,
      createdAt: "2026-11-08T00:00:00.000Z",
      verifiedAt: "2026-11-09T00:00:00.000Z",
    });
    expect(resolve([v1, pending, v2])).toMatchObject({
      status: "verified",
      row: { id: "evidence-v2" },
    });
    // Before v2 was verified the pending correction still holds the assessment.
    expect(
      resolveBillingEvidenceLineage({
        rows: [v1, pending, v2],
        serviceFrom: "2026-11-01",
        serviceTo: "2026-11-10",
        assessedAt: "2026-11-07T00:00:00.000Z",
      }),
    ).toEqual({ status: "unresolved", reasonCode: "BILLING_EVIDENCE_CORRECTION_PENDING" });
  });

  it("resolves an unverified row once its verified successor exists", () => {
    const unverified = base({
      id: "evidence-unverified",
      verificationStatus: "unverified",
      createdAt: "2026-11-01T00:00:00.000Z",
      verifiedAt: null,
    });
    const verified = base({
      id: "evidence-verified",
      supersedesId: unverified.id,
      createdAt: "2026-11-05T00:00:00.000Z",
      verifiedAt: "2026-11-06T00:00:00.000Z",
    });
    expect(resolve([unverified, verified])).toMatchObject({
      status: "verified",
      row: { id: "evidence-verified" },
    });
  });

  it("a revoked or superseded row closes its predecessor from the moment it was recorded, not from verified_at", () => {
    // The database requires verified_at on a closed row (closed_provenance), and verified_at may be later than
    // created_at. An assessment between the two must not revive the predecessor as the verified head.
    const predecessor = base({ id: "evidence-a" });
    const revoked = base({
      id: "evidence-revoked",
      supersedesId: predecessor.id,
      verificationStatus: "revoked",
      createdAt: "2026-11-08T00:00:00.000Z",
      verifiedAt: "2026-11-12T00:00:00.000Z",
    });
    expect(resolve([predecessor, revoked])).toEqual({
      status: "unresolved",
      reasonCode: "BILLING_EVIDENCE_REVOKED",
    });
    // Control: before the revoking row was recorded, the predecessor is still the head.
    expect(
      resolveBillingEvidenceLineage({
        rows: [predecessor, revoked],
        serviceFrom: "2026-11-01",
        serviceTo: "2026-11-10",
        assessedAt: "2026-11-07T00:00:00.000Z",
      }),
    ).toMatchObject({ status: "verified", row: { id: "evidence-a" } });

    const supersededStatus = {
      ...revoked,
      id: "evidence-superseded",
      verificationStatus: "superseded",
    };
    expect(resolve([predecessor, supersededStatus])).toEqual({
      status: "unresolved",
      reasonCode: "BILLING_EVIDENCE_UNVERIFIED",
    });
  });
});

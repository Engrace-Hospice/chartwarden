import { describe, expect, it } from "vitest";
import {
  type ProgramAssignmentCandidate,
  enrollmentTransactionMatches,
  resolveProgramResponsibility,
  resolveProviderPayerRoute,
  verificationSourceAllowed,
} from "./program-responsibility";

const assignment = (
  id: string,
  extra: Partial<ProgramAssignmentCandidate> = {},
): ProgramAssignmentCandidate => ({
  id,
  programKind: "managed_care",
  canonicalPayerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  status: "verified",
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  ...extra,
});

describe("enrollmentTransactionMatches", () => {
  it("does not let 835 route evidence qualify an 837I transaction", () => {
    expect(enrollmentTransactionMatches("835", "837I")).toBe(false);
    expect(enrollmentTransactionMatches("837I", "837I")).toBe(true);
    expect(enrollmentTransactionMatches(null, "837I")).toBe(false);
    expect(enrollmentTransactionMatches("835", "835")).toBe(true);
    expect(enrollmentTransactionMatches(null, null)).toBe(true);
  });
});

describe("verificationSourceAllowed", () => {
  it("requires evidence sources appropriate to the enrollment kind", () => {
    expect(
      verificationSourceAllowed("state_medicaid_provider_enrollment", "internal_approval"),
    ).toBe(false);
    expect(verificationSourceAllowed("clearinghouse_payer_route", "clearinghouse_sandbox")).toBe(
      false,
    );
    expect(
      verificationSourceAllowed("clearinghouse_payer_route", "clearinghouse_written_confirmation"),
    ).toBe(true);
    expect(verificationSourceAllowed("production_activation_approval", "internal_approval")).toBe(
      true,
    );
    expect(verificationSourceAllowed("program_assignment", "internal_approval", true)).toBe(false);
  });
});

describe("resolveProviderPayerRoute", () => {
  it("resolves distinct provider-entity route choices without inheriting the tenant account", () => {
    const sharedServiceWindow = {
      status: "pending",
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-12-31",
    };
    const tenantAccount = { source: "tenant", vendor: "stedi", status: "active" };
    const providerA = resolveProviderPayerRoute(
      [{ ...sharedServiceWindow, clearinghouse: "stedi" }],
      "2026-06-01",
      "2026-06-30",
      tenantAccount,
    );
    const providerB = resolveProviderPayerRoute(
      [{ ...sharedServiceWindow, clearinghouse: "claimmd" }],
      "2026-06-01",
      "2026-06-30",
      tenantAccount,
    );
    expect(providerA).toMatchObject({
      status: "selected",
      vendor: "stedi",
      configurationStatus: "active",
    });
    expect(providerB).toMatchObject({
      status: "selected",
      vendor: "claimmd",
      configurationStatus: "TENANT_ACCOUNT_NOT_CONFIGURED_FOR_PROVIDER_ROUTE",
    });
  });

  it("refuses gaps, partial windows and conflicting route selections", () => {
    expect(resolveProviderPayerRoute([], "2026-01-01", "2026-01-31", null)).toMatchObject({
      status: "missing",
      configurationStatus: "PROVIDER_PAYER_ROUTE_SELECTION_MISSING",
    });
    expect(
      resolveProviderPayerRoute(
        [
          {
            clearinghouse: "stedi",
            status: "pending",
            effectiveFrom: "2026-01-02",
            effectiveTo: null,
          },
        ],
        "2026-01-01",
        "2026-01-31",
        null,
      ),
    ).toMatchObject({
      status: "unavailable",
      configurationStatus: "PROVIDER_PAYER_ROUTE_DOES_NOT_COVER_SERVICE_RANGE",
    });
    expect(
      resolveProviderPayerRoute(
        [
          {
            clearinghouse: "stedi",
            status: "pending",
            effectiveFrom: "2026-01-01",
            effectiveTo: null,
          },
          {
            clearinghouse: "claimmd",
            status: "pending",
            effectiveFrom: "2026-01-01",
            effectiveTo: null,
          },
        ],
        "2026-01-01",
        "2026-01-31",
        null,
      ),
    ).toMatchObject({
      status: "unavailable",
      configurationStatus: "PROVIDER_PAYER_ROUTE_AMBIGUOUS",
    });
  });
});

describe("resolveProgramResponsibility", () => {
  it("requires one explicitly verified FFS identity over the full range", () => {
    expect(
      resolveProgramResponsibility(
        [
          assignment("ffs", {
            programKind: "ffs_open_card",
            canonicalPayerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          }),
        ],
        "2026-01-01",
        "2026-01-31",
      ),
    ).toMatchObject({ status: "verified", programKind: "ffs_open_card" });
    expect(resolveProgramResponsibility([], "2026-01-01", "2026-01-31")).toMatchObject({
      status: "missing",
      reasonCode: "PROGRAM_ASSIGNMENT_MISSING",
    });
  });

  it("handles effective boundaries and refuses a responsibility change or gap", () => {
    const eocco = assignment("eocco", { effectiveTo: "2026-01-15" });
    const ffs = assignment("ffs", {
      programKind: "ffs_open_card",
      canonicalPayerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      effectiveFrom: "2026-01-16",
    });
    expect(resolveProgramResponsibility([eocco], "2026-01-01", "2026-01-15")).toMatchObject({
      status: "verified",
    });
    expect(resolveProgramResponsibility([eocco, ffs], "2026-01-01", "2026-01-31")).toMatchObject({
      status: "changes",
      reasonCode: "PROGRAM_RESPONSIBILITY_CHANGES",
    });
    expect(
      resolveProgramResponsibility(
        [assignment("partial", { effectiveTo: "2026-01-15" })],
        "2026-01-01",
        "2026-01-31",
      ),
    ).toMatchObject({ status: "expired", reasonCode: "PROGRAM_ASSIGNMENT_EXPIRED" });
  });

  it("keeps pending, overlap ambiguity, and unsupported assignments distinct", () => {
    expect(
      resolveProgramResponsibility(
        [assignment("pending", { status: "pending" })],
        "2026-01-01",
        "2026-01-31",
      ),
    ).toMatchObject({ status: "pending" });
    expect(
      resolveProgramResponsibility([assignment("a"), assignment("b")], "2026-01-01", "2026-01-31"),
    ).toMatchObject({ status: "ambiguous" });
    expect(
      resolveProgramResponsibility(
        [assignment("unsupported", { programKind: "unsupported" })],
        "2026-01-01",
        "2026-01-31",
      ),
    ).toMatchObject({ status: "unsupported", reasonCode: "PROGRAM_UNSUPPORTED" });
  });

  it("reports rejected, revoked, and expired evidence without reclassifying it", () => {
    expect(
      resolveProgramResponsibility(
        [assignment("rejected", { status: "rejected" })],
        "2026-01-01",
        "2026-01-31",
      ),
    ).toMatchObject({ status: "rejected", reasonCode: "PROGRAM_ASSIGNMENT_REJECTED" });
    expect(
      resolveProgramResponsibility(
        [assignment("revoked", { status: "revoked" })],
        "2026-01-01",
        "2026-01-31",
      ),
    ).toMatchObject({ status: "revoked", reasonCode: "PROGRAM_ASSIGNMENT_REVOKED" });
    expect(
      resolveProgramResponsibility(
        [assignment("expired", { effectiveTo: "2026-01-15" })],
        "2026-01-01",
        "2026-01-31",
      ),
    ).toMatchObject({ status: "expired", reasonCode: "PROGRAM_ASSIGNMENT_EXPIRED" });
  });
});

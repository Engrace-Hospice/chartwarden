import { describe, expect, it, vi } from "vitest";
import {
  type PayerRouteEvidenceRow,
  type ProgramAssignmentCandidate,
  enrollmentTransactionMatches,
  previewProgramResponsibility,
  readTenantClearinghouseAccount,
  resolveProgramResponsibility,
  resolveProviderPayerRoute,
  routeRowsForPayer,
  routeVendorPayerId,
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

  it("lets a verified route speak over a mistaken pending one that nothing can withdraw", () => {
    const window = { effectiveFrom: "2026-01-01", effectiveTo: null };
    expect(
      resolveProviderPayerRoute(
        [
          { ...window, clearinghouse: "stedi", status: "verified" },
          { ...window, clearinghouse: "claimmd", status: "pending" },
        ],
        "2026-01-01",
        "2026-01-31",
        null,
      ),
    ).toMatchObject({ status: "selected", vendor: "stedi" });
    // Two verified routes for one window are still a conflict.
    expect(
      resolveProviderPayerRoute(
        [
          { ...window, clearinghouse: "stedi", status: "verified" },
          { ...window, clearinghouse: "claimmd", status: "verified" },
        ],
        "2026-01-01",
        "2026-01-31",
        null,
      ),
    ).toMatchObject({ configurationStatus: "PROVIDER_PAYER_ROUTE_AMBIGUOUS" });
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

  it("refuses a window that several contiguous records cover, since a claim names one assignment", () => {
    const first = assignment("first", { effectiveTo: "2026-01-15" });
    const second = assignment("second", { effectiveFrom: "2026-01-16" });
    expect(resolveProgramResponsibility([first, second], "2026-01-01", "2026-01-31")).toMatchObject(
      {
        status: "ambiguous",
        programKind: "ambiguous",
        canonicalPayerId: null,
        assignmentIds: ["first", "second"],
        reasonCode: "PROGRAM_ASSIGNMENT_SPANS_MULTIPLE_RECORDS",
      },
    );
    // each half on its own is still a single-record, verified window
    expect(resolveProgramResponsibility([first, second], "2026-01-01", "2026-01-15")).toMatchObject(
      {
        status: "verified",
        assignmentIds: ["first"],
      },
    );
    expect(resolveProgramResponsibility([first, second], "2026-01-16", "2026-01-31")).toMatchObject(
      {
        status: "verified",
        assignmentIds: ["second"],
      },
    );
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

describe("previewProgramResponsibility", () => {
  it("returns exactly the declared preview fields, without the server-side assignment ids", () => {
    const resolution = resolveProgramResponsibility(
      [assignment("first")],
      "2026-01-01",
      "2026-01-31",
    );
    expect(resolution.assignmentIds).toEqual(["first"]);
    const view = previewProgramResponsibility(resolution);
    expect(Object.keys(view).sort()).toEqual([
      "canonicalPayerId",
      "canonicalPayerName",
      "programKind",
      "reasonCode",
      "status",
    ]);
    expect(view).toMatchObject({
      status: "verified",
      programKind: "managed_care",
      canonicalPayerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      canonicalPayerName: null,
      reasonCode: "PROGRAM_RESPONSIBILITY_VERIFIED",
    });
  });
});

describe("payer route evidence in the claim assembly preview", () => {
  const PAYER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const route = (extra: Partial<PayerRouteEvidenceRow> = {}): PayerRouteEvidenceRow => ({
    evidenceKind: "clearinghouse_payer_route",
    canonicalPayerId: PAYER,
    clearinghouse: "stedi",
    transactionType: "837I",
    vendorPayerId: "SYNTH-STEDI",
    status: "verified",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    ...extra,
  });

  it("matches no row for an unresolved program, even a payer-less one", () => {
    const payerless = route({ canonicalPayerId: null });
    expect(routeRowsForPayer([payerless], null)).toEqual([]);
    expect(routeRowsForPayer([payerless, route()], PAYER)).toEqual([route()]);
  });

  it("keeps only 837I payer-route evidence of the program's payer", () => {
    const rows = [
      route(),
      route({ transactionType: "835" }),
      route({ evidenceKind: "837i_enrollment" }),
      route({ canonicalPayerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
    ];
    expect(routeRowsForPayer(rows, PAYER)).toEqual([route()]);
  });

  it("maps the vendor payer id from the verified row, not a pending twin of the same vendor", () => {
    const rows = [route(), route({ status: "pending", vendorPayerId: "SYNTH-WRONG" })];
    expect(routeVendorPayerId(rows, "stedi", "2026-02-01", "2026-02-28")).toBe("SYNTH-STEDI");
    // Two verified rows for one vendor and window are not one mapping.
    expect(
      routeVendorPayerId(
        [route(), route({ vendorPayerId: "SYNTH-OTHER" })],
        "stedi",
        "2026-02-01",
        "2026-02-28",
      ),
    ).toBeNull();
  });

  it("maps nothing without a selected vendor, outside the window, or from another vendor's row", () => {
    expect(
      routeVendorPayerId([route({ clearinghouse: null })], null, "2026-02-01", "2026-02-28"),
    ).toBeNull();
    expect(
      routeVendorPayerId(
        [route({ effectiveTo: "2026-01-31" })],
        "stedi",
        "2026-02-01",
        "2026-02-28",
      ),
    ).toBeNull();
    expect(routeVendorPayerId([route()], "claimmd", "2026-02-01", "2026-02-28")).toBeNull();
  });
});

describe("the tenant clearinghouse account read", () => {
  it("reads the tenant's selected route", async () => {
    const reader = {
      selectedTenantRoute: async () => ({ source: "tenant", vendor: "stedi", status: "active" }),
    };
    await expect(readTenantClearinghouseAccount(reader, "org-1")).resolves.toEqual({
      source: "tenant",
      vendor: "stedi",
      status: "active",
    });
  });

  it("reads as unavailable, without a log line, when no reader is bound", async () => {
    const warn = vi.fn();
    await expect(readTenantClearinghouseAccount(undefined, "org-1", warn)).resolves.toEqual({
      source: "unavailable",
      vendor: null,
      status: null,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs a reader outage with the organization and the error class only", async () => {
    const warn = vi.fn();
    const reader = {
      selectedTenantRoute: async () => {
        throw new TypeError("connection to synthetic-host refused");
      },
    };
    await expect(readTenantClearinghouseAccount(reader, "org-1", warn)).resolves.toEqual({
      source: "unavailable",
      vendor: null,
      status: null,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      event: "m24.preview.tenant_clearinghouse_reader_failed",
      organizationId: "org-1",
      errorName: "TypeError",
    });
    expect(line).not.toContain("synthetic-host");
  });
});

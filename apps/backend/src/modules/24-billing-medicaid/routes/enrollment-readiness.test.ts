import { describe, expect, it } from "vitest";
import {
  type EnrollmentEvidenceFacts,
  enrollmentRequirementStatus,
  tradingPartnerCredentialStatus,
} from "./enrollment-readiness";

const PAYER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_PAYER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FROM = "2026-02-01";
const TO = "2026-02-28";

const utc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const evidence = (extra: Partial<EnrollmentEvidenceFacts> = {}): EnrollmentEvidenceFacts => ({
  evidenceKind: "837i_enrollment",
  transactionType: "837I",
  canonicalPayerId: PAYER,
  programKind: "managed_care",
  clearinghouse: null,
  status: "verified",
  effectiveFrom: utc("2026-01-01"),
  effectiveTo: null,
  ...extra,
});

const status = (
  rows: readonly EnrollmentEvidenceFacts[],
  kind: Parameters<typeof enrollmentRequirementStatus>[1] = "837i_enrollment",
  over: {
    canonicalPayerId?: string | null;
    programKind?: string | null;
    selectedClearinghouse?: string | null;
    requiredTransactionType?: "837I" | "835" | null;
  } = {},
) =>
  enrollmentRequirementStatus(
    rows,
    kind,
    FROM,
    TO,
    over.canonicalPayerId === undefined ? PAYER : over.canonicalPayerId,
    over.programKind === undefined ? "managed_care" : over.programKind,
    over.selectedClearinghouse === undefined ? null : over.selectedClearinghouse,
    over.requiredTransactionType === undefined ? "837I" : over.requiredTransactionType,
  );

describe("enrollmentRequirementStatus", () => {
  it("marks MCO participation not applicable to fee-for-service", () => {
    expect(
      status([], "mco_participation", {
        programKind: "ffs_open_card",
        requiredTransactionType: null,
      }),
    ).toMatchObject({ status: "not_applicable" });
  });

  it("needs a resolved payer for every kind except state provider enrollment", () => {
    expect(status([evidence()], "837i_enrollment", { canonicalPayerId: null })).toMatchObject({
      status: "unavailable",
      reasonCode: "PROGRAM_PAYER_IDENTITY_UNRESOLVED",
    });
    expect(
      status(
        [
          evidence({
            evidenceKind: "state_medicaid_provider_enrollment",
            transactionType: null,
            canonicalPayerId: null,
          }),
        ],
        "state_medicaid_provider_enrollment",
        { canonicalPayerId: null, requiredTransactionType: null },
      ),
    ).toMatchObject({ status: "verified" });
  });

  it("needs the tenant's selected clearinghouse for route-bound kinds", () => {
    expect(status([], "clearinghouse_payer_route", { selectedClearinghouse: null })).toMatchObject({
      status: "unavailable",
      reasonCode: "TENANT_CLEARINGHOUSE_SELECTION_UNBOUND",
    });
  });

  it("reports verified only when one verified row covers the whole window", () => {
    expect(status([evidence()])).toMatchObject({
      status: "verified",
      reasonCode: "ENROLLMENT_EVIDENCE_VERIFIED",
    });
    expect(status([evidence({ effectiveTo: utc("2026-02-10") })])).toMatchObject({
      status: "expired",
    });
    expect(status([evidence({ effectiveFrom: utc("2026-02-10") })])).toMatchObject({
      status: "missing",
      reasonCode: "ENROLLMENT_EVIDENCE_NOT_CURRENT",
    });
    expect(status([])).toMatchObject({ status: "missing" });
  });

  it("does not let 835 evidence satisfy an 837I requirement", () => {
    expect(
      status([evidence({ evidenceKind: "837i_enrollment", transactionType: "835" })]),
    ).toMatchObject({ status: "missing" });
  });

  it("keeps pending, revoked and rejected evidence distinct from missing", () => {
    expect(status([evidence({ status: "pending" })])).toMatchObject({ status: "pending" });
    expect(status([evidence({ status: "revoked" })])).toMatchObject({ status: "revoked" });
    expect(status([evidence({ status: "rejected" })])).toMatchObject({
      status: "missing",
      reasonCode: "ENROLLMENT_EVIDENCE_REJECTED",
    });
  });

  it("is ambiguous when two verified rows overlap the window", () => {
    expect(status([evidence(), evidence({ effectiveFrom: utc("2026-02-15") })])).toMatchObject({
      status: "ambiguous",
      reasonCode: "ENROLLMENT_EVIDENCE_AMBIGUOUS",
    });
  });
});

describe("tradingPartnerCredentialStatus", () => {
  const cred = (from: string, to: string | null) => ({
    activeFrom: utc(from),
    activeTo: to ? utc(to) : null,
  });

  it("reports missing, expired and future-dated credentials", () => {
    expect(tradingPartnerCredentialStatus([], FROM, TO)).toMatchObject({ status: "missing" });
    expect(
      tradingPartnerCredentialStatus([cred("2025-01-01", "2026-01-15")], FROM, TO),
    ).toMatchObject({ status: "expired" });
    expect(tradingPartnerCredentialStatus([cred("2026-04-01", null)], FROM, TO)).toMatchObject({
      status: "future",
    });
  });

  it("reports configured, partial and ambiguous windows", () => {
    expect(tradingPartnerCredentialStatus([cred("2026-01-01", null)], FROM, TO)).toMatchObject({
      status: "configured",
    });
    expect(
      tradingPartnerCredentialStatus([cred("2026-01-01", "2026-02-10")], FROM, TO),
    ).toMatchObject({ status: "partial" });
    expect(tradingPartnerCredentialStatus([cred("2026-02-10", null)], FROM, TO)).toMatchObject({
      status: "future",
      reasonCode: "TRADING_PARTNER_CREDENTIAL_STARTS_DURING_WINDOW",
    });
    expect(
      tradingPartnerCredentialStatus(
        [cred("2026-01-01", null), cred("2026-02-05", null)],
        FROM,
        TO,
      ),
    ).toMatchObject({ status: "ambiguous" });
  });
});

describe("enrollmentRequirementStatus payer binding", () => {
  it("never matches a row recorded for a different payer", () => {
    expect(status([evidence({ canonicalPayerId: OTHER_PAYER })])).toMatchObject({
      status: "missing",
    });
  });
});

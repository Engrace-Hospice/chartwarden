// apps/backend/src/modules/24-billing-medicaid/routes/enrollment-readiness.ts — pure readiness projection of
// provider enrollment evidence and trading-partner credentials for a claim's service window (claim assembly
// preview). Moved out of write-service-drizzle.ts so the rules can be unit-tested without a database.
import { enrollmentTransactionMatches } from "./program-responsibility";
import type { AssemblyPreviewView } from "./write-service";

export const ENROLLMENT_REQUIREMENTS = [
  "state_medicaid_provider_enrollment",
  "mco_participation",
  "837i_enrollment",
  "835_era_enrollment",
  "clearinghouse_payer_route",
  "institutional_format_qualification",
  "payer_transport_certification",
  "production_activation_approval",
] as const;

export type EnrollmentRequirementKind = (typeof ENROLLMENT_REQUIREMENTS)[number];

/** The evidence-row facts readiness reads (a structural subset of the `medicaid_enrollment_evidence` row). */
export interface EnrollmentEvidenceFacts {
  readonly evidenceKind: string;
  readonly transactionType: string | null;
  readonly canonicalPayerId: string | null;
  readonly programKind: string | null;
  readonly clearinghouse: string | null;
  readonly status: string;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
}

const day = (d: Date): string => d.toISOString().slice(0, 10);

export function enrollmentRequirementStatus(
  rows: ReadonlyArray<EnrollmentEvidenceFacts>,
  kind: EnrollmentRequirementKind,
  from: string,
  to: string,
  canonicalPayerId: string | null,
  programKind: string | null,
  selectedClearinghouse: string | null,
  requiredTransactionType: "837I" | "835" | null,
): AssemblyPreviewView["enrollmentReadiness"][number] {
  if (kind === "mco_participation" && programKind === "ffs_open_card") {
    return {
      kind,
      status: "not_applicable",
      reasonCode: "MCO_PARTICIPATION_NOT_APPLICABLE_TO_FFS",
    };
  }
  if (kind !== "state_medicaid_provider_enrollment" && !canonicalPayerId) {
    return { kind, status: "unavailable", reasonCode: "PROGRAM_PAYER_IDENTITY_UNRESOLVED" };
  }
  if (
    (kind === "clearinghouse_payer_route" ||
      kind === "institutional_format_qualification" ||
      kind === "payer_transport_certification" ||
      kind === "production_activation_approval") &&
    !selectedClearinghouse
  ) {
    return { kind, status: "unavailable", reasonCode: "TENANT_CLEARINGHOUSE_SELECTION_UNBOUND" };
  }
  const relevant = rows.filter((row) => {
    if (row.evidenceKind !== kind) return false;
    if (!enrollmentTransactionMatches(row.transactionType, requiredTransactionType)) return false;
    if (row.canonicalPayerId && row.canonicalPayerId !== canonicalPayerId) return false;
    if (
      (kind === "clearinghouse_payer_route" ||
        kind === "institutional_format_qualification" ||
        kind === "payer_transport_certification" ||
        kind === "production_activation_approval") &&
      row.clearinghouse !== selectedClearinghouse
    )
      return false;
    return day(row.effectiveFrom) <= to && (!row.effectiveTo || day(row.effectiveTo) >= from);
  });
  if (relevant.length > 1)
    return { kind, status: "ambiguous", reasonCode: "ENROLLMENT_EVIDENCE_AMBIGUOUS" };
  const row = relevant[0];
  if (!row) return { kind, status: "missing", reasonCode: "ENROLLMENT_EVIDENCE_MISSING" };
  if (row.status === "revoked")
    return { kind, status: "revoked", reasonCode: "ENROLLMENT_EVIDENCE_REVOKED" };
  if (row.status === "expired" || (row.effectiveTo && day(row.effectiveTo) < to))
    return { kind, status: "expired", reasonCode: "ENROLLMENT_EVIDENCE_EXPIRED_OR_PARTIAL" };
  if (row.status === "pending")
    return { kind, status: "pending", reasonCode: "ENROLLMENT_EVIDENCE_PENDING" };
  if (row.status === "rejected")
    return { kind, status: "missing", reasonCode: "ENROLLMENT_EVIDENCE_REJECTED" };
  if (
    row.status === "verified" &&
    day(row.effectiveFrom) <= from &&
    (!row.effectiveTo || day(row.effectiveTo) >= to)
  ) {
    return { kind, status: "verified", reasonCode: "ENROLLMENT_EVIDENCE_VERIFIED" };
  }
  return { kind, status: "missing", reasonCode: "ENROLLMENT_EVIDENCE_NOT_CURRENT" };
}

export function tradingPartnerCredentialStatus(
  rows: ReadonlyArray<{ activeFrom: Date; activeTo: Date | null }>,
  from: string,
  to: string,
): AssemblyPreviewView["tradingPartnerCredential"] {
  const relevant = rows.filter(
    (row) => day(row.activeFrom) <= to && (!row.activeTo || day(row.activeTo) >= from),
  );
  if (relevant.length === 0) {
    const latest = [...rows].sort((a, b) => day(b.activeFrom).localeCompare(day(a.activeFrom)))[0];
    if (latest?.activeTo && day(latest.activeTo) < from)
      return { status: "expired", reasonCode: "TRADING_PARTNER_CREDENTIAL_EXPIRED" };
    if (rows.some((row) => day(row.activeFrom) > to))
      return { status: "future", reasonCode: "TRADING_PARTNER_CREDENTIAL_FUTURE_DATED" };
    return { status: "missing", reasonCode: "TRADING_PARTNER_CREDENTIAL_MISSING" };
  }
  if (relevant.length > 1)
    return { status: "ambiguous", reasonCode: "TRADING_PARTNER_CREDENTIAL_AMBIGUOUS" };
  const row = relevant[0]!;
  if (day(row.activeFrom) > from)
    return { status: "future", reasonCode: "TRADING_PARTNER_CREDENTIAL_STARTS_DURING_WINDOW" };
  if (row.activeTo && day(row.activeTo) < to)
    return { status: "partial", reasonCode: "TRADING_PARTNER_CREDENTIAL_EXPIRES_DURING_WINDOW" };
  return { status: "configured", reasonCode: "TRADING_PARTNER_CREDENTIAL_CONFIGURED_ONLY" };
}

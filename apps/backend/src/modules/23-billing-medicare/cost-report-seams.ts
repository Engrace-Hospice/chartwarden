// apps/backend/src/modules/23-billing-medicare/cost-report-seams.ts — M23's published-seam registration into
// the M1 SeamRegistry (the M26 `registerM26PublishedSeams` precedent). This was the FIRST M23→M1 publish:
// M23 was outbox-only before, reachable cross-module only via its §4.10 events. Despite the filename (its
// original scope), this is now M23's general published-seams file — three seams, one registration entrypoint,
// the established "keep growing the same function" house style (see M30's published-seams.ts:3 for the
// explicit naming of this precedent).
//
// Registers the §4.4 `PatientDaysProvider` so M27's cost-report Worksheet-D statistical census reconciliation
// resolves the live billed-and-accepted patient-day aggregate via `getSeam` over the fail-closed deny-stub.
// The read runs under `withOrgContext` (RLS-scoped to the caller's org via a synthetic system actor); the
// aggregate is a single day count — no patient row, no MBI (D13/D18). No db → the M1 deny-stub stands.
import { repositories } from "@wardenx/billing";
import type {
  BilledDaysAggregate,
  ClaimLineRollup,
  ClaimMatchCandidateRow,
} from "@wardenx/billing";
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { AppealClaimCopy } from "@wardenx/types";
import { registerSeam } from "../../bootstrap/index";

/** The M23 → M27 billed-census seam contract. Opaque in the M1 registry (`unknown`); M27 casts to its own
 *  minimal view. Aggregate, FY-scoped, PHI-free (D18). */
export interface PatientDaysProvider {
  /** Billed-and-accepted hospice patient-days for the FY `[fyStartIso, fyEndIso]` (inclusive ISO dates). */
  billedDaysForFiscalYear(
    orgId: string,
    fyStartIso: string,
    fyEndIso: string,
  ): Promise<BilledDaysAggregate>;
}

/** Build the live `PatientDaysProvider` over the M23 billing aggregate repo, RLS-scoped per call. */
export function buildM23PatientDaysProvider(db: DbClient): PatientDaysProvider {
  return {
    async billedDaysForFiscalYear(orgId, fyStartIso, fyEndIso) {
      return withOrgContext(db, { organizationId: orgId, userId: "system" }, (tx) =>
        new repositories.CostReportAggregateRepository(tx).billedDaysForFiscalYear(
          orgId,
          fyStartIso,
          fyEndIso,
        ),
      );
    },
  };
}

/** The M23 → M30 claim-line seam contract. Opaque in the M1 registry (`unknown`); M30 casts to its own
 *  consumer view. Aggregate day counts + the per-diem LINE population over a window — no patient row (D18). */
export interface ClaimLineReader {
  /** Per-LOC billed-and-accepted per-diem day rollup + line count over `[fromIso, toIso]` (inclusive). */
  claimLineRollupForPeriod(orgId: string, fromIso: string, toIso: string): Promise<ClaimLineRollup>;
}

/**
 * Build the live `ClaimLineReader` over the SAME aggregate repo `PatientDaysProvider` uses, RLS-scoped per
 * call. Sharing the repo is deliberate: the HCI claims-derived indicators and the cost-report census must
 * agree on what counts as a billed day, and two queries would eventually drift.
 */
export function buildM23ClaimLineReader(db: DbClient): ClaimLineReader {
  return {
    async claimLineRollupForPeriod(orgId, fromIso, toIso) {
      return withOrgContext(db, { organizationId: orgId, userId: "system" }, (tx) =>
        new repositories.CostReportAggregateRepository(tx).claimLineRollupForPeriod(
          orgId,
          fromIso,
          toIso,
        ),
      );
    },
  };
}

/** The M23 → M25 835-to-claim match seam (WX-PR-012). Opaque in the M1 registry (`unknown`); M25 casts to
 *  its own `ClaimMatchCandidateProvider` consumer view. `candidatesForLine` is the D3 auto-match candidate
 *  set (claim-control-number / payer-ICN exact matches only — M25's pure `autoMatch` decides which, if
 *  any, strategy binds); `patientIdForClaim` resolves a matched claim's patient id (WX-PR-012 PR-ledger
 *  seeding). PHI: `patientIdForClaim` returns a patient id, `candidatesForLine` does not. */
export interface ClaimSubmissionReader {
  candidatesForLine(
    orgId: string,
    providerEntityId: string,
    keys: { payerIcn?: string; claimControlNumber?: string },
  ): Promise<ClaimMatchCandidateRow[]>;
  patientIdForClaim(orgId: string, claimId: string): Promise<string | null>;
  /**
   * GAP-036 - the claim M25's appeal packet encloses: header + lines (what was billed) and the patient the packet's
   * enclosure documents must belong to. Org-scoped (a claim of another tenant reads as absent). No MBI (D13); the
   * lines carry codes, dates, units and charges only.
   */
  claimCopyForAppeal(
    orgId: string,
    claimId: string,
  ): Promise<{ patientId: string; copy: AppealClaimCopy } | null>;
}

/** Build the live `ClaimSubmissionReader` over the `claim` repo, RLS-scoped per call. */
export function buildM23ClaimSubmissionReader(db: DbClient): ClaimSubmissionReader {
  return {
    async candidatesForLine(orgId, providerEntityId, keys) {
      return withOrgContext(db, { organizationId: orgId, userId: "system" }, (tx) =>
        new repositories.ClaimRepository(tx).findMatchCandidates(orgId, providerEntityId, {
          payerClaimControlNumber: keys.payerIcn,
          claimControlNumber: keys.claimControlNumber,
        }),
      );
    },
    async patientIdForClaim(orgId, claimId) {
      return withOrgContext(db, { organizationId: orgId, userId: "system" }, (tx) =>
        new repositories.ClaimRepository(tx).patientIdForId(claimId),
      );
    },
    async claimCopyForAppeal(orgId, claimId) {
      return withOrgContext(db, { organizationId: orgId, userId: "system" }, async (tx) => {
        const claim = await new repositories.ClaimRepository(tx).findById(claimId);
        if (!claim || claim.organizationId !== orgId) return null;
        const lines = await new repositories.ClaimLineRepository(tx).listForClaim(claimId);
        return { patientId: claim.patientId, copy: toAppealClaimCopy(claim, lines) };
      });
    },
  };
}

/** Pure: a claim + its lines -> the appeal packet's claim copy. */
export function toAppealClaimCopy(
  claim: Pick<
    repositories.ClaimRecord,
    "claimControlNumber" | "tob" | "state" | "serviceFrom" | "serviceTo" | "totalChargeCents"
  >,
  lines: readonly repositories.ClaimLineRecord[],
): AppealClaimCopy {
  return {
    controlNumber: claim.claimControlNumber,
    tob: claim.tob,
    state: claim.state,
    serviceFrom: claim.serviceFrom,
    serviceTo: claim.serviceTo,
    totalChargeCents: claim.totalChargeCents,
    lines: lines.map((line) => ({
      lineNumber: line.lineNumber,
      revenueCode: line.revenueCode,
      hcpcsCode: line.qCode ?? null,
      serviceFrom: line.serviceDateFrom,
      serviceTo: line.serviceDateTo,
      units: line.unitCount,
      chargeCents: line.lineChargeCents,
    })),
  };
}

/** Register M23's published seams into the M1 registry. No-op without a db (the deny-stubs stand). */
export function registerM23PublishedSeams(db: DbClient | undefined): void {
  if (!db) return;
  registerSeam("PatientDaysProvider", buildM23PatientDaysProvider(db));
  // M30's HCI claims-derived indicators — the second M23 publish (same repo, windowed grain).
  registerSeam("ClaimLineReader", buildM23ClaimLineReader(db));
  // M25's 835-to-claim auto-match + PR-ledger patient resolution — the third M23 publish (WX-PR-012).
  registerSeam("ClaimSubmissionReader", buildM23ClaimSubmissionReader(db));
}

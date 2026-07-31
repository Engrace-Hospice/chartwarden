// apps/backend/src/modules/23-billing-medicare/cost-report-seams.ts — M23's published-seam registration into
// the M1 SeamRegistry for the M27 cost-report binds (the M26 `registerM26PublishedSeams` precedent). This is
// the FIRST M23→M1 publish: M23 was outbox-only before, reachable cross-module only via its §4.10 events.
//
// Registers the §4.4 `PatientDaysProvider` so M27's cost-report Worksheet-D statistical census reconciliation
// resolves the live billed-and-accepted patient-day aggregate via `getSeam` over the fail-closed deny-stub.
// The read runs under `withOrgContext` (RLS-scoped to the caller's org via a synthetic system actor); the
// aggregate is a single day count — no patient row, no MBI (D13/D18). No db → the M1 deny-stub stands.
import { repositories } from "@wardenx/billing";
import type { BilledDaysAggregate, ClaimLineRollup } from "@wardenx/billing";
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
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
  claimLineRollupForPeriod(
    orgId: string,
    fromIso: string,
    toIso: string,
  ): Promise<ClaimLineRollup>;
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

/** Register M23's published seams into the M1 registry. No-op without a db (the deny-stubs stand). */
export function registerM23PublishedSeams(db: DbClient | undefined): void {
  if (!db) return;
  registerSeam("PatientDaysProvider", buildM23PatientDaysProvider(db));
  // M30's HCI claims-derived indicators — the second M23 publish (same repo, windowed grain).
  registerSeam("ClaimLineReader", buildM23ClaimLineReader(db));
}

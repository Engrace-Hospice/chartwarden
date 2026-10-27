// apps/backend/src/modules/41-billing-commercial/erasers/commercial-billing-eraser.ts — the M41 ORGANIZATION-destruction eraser
// (issue #838). Every M41 table has a RESTRICT FK to `organization`, so the M4 org-destruction driver must empty them before it
// deletes the org. Same shape as M23's `eraseOrgBillingConfig` (billing-eraser.ts): the driver sets `app.org_id` (withOrgContext)
// on a `chartwarden_destruction` connection and passes that transaction in; migration 1287 grants SELECT+DELETE and the
// org-pinned destruction policy per table. The driver binding itself is not wired here (same as M23 — documented there).
//
// ORDER (children first): override, result, acknowledgment, quarantine, cursor, submission, state history, claim line,
// then the claim<->validation-run cycle (claim.latest_validation_run_id and run.claim_id are both RESTRICT, so the claim's run
// pointer is cleared first — the one column-limited UPDATE 1287 grants), runs, claims; then the plan-side rows
// (authorization, eligibility check, enrollment, contract rate, route, plan), which the claim side referenced.
import { type DbClient, schema } from "@chartwarden/db";
import { eq } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

const S = schema;

/** Rows deleted per table, keyed by the SQL table name. */
export type CommercialBillingEraseCounts = Readonly<Record<string, number>>;

export interface CommercialBillingEraseStore {
  eraseOrgCommercialBilling(input: {
    organizationId: string;
  }): Promise<CommercialBillingEraseCounts>;
}

type OrgScopedTable = PgTable & { organizationId: AnyPgColumn };
type Pass = readonly [sqlName: string, table: OrgScopedTable];

const BEFORE_RUN_POINTER: readonly Pass[] = [
  ["commercial_validation_override", S.commercialValidationOverrides],
  ["commercial_validation_result", S.commercialValidationResults],
  ["commercial_acknowledgment", S.commercialAcknowledgments],
  ["commercial_ack_quarantine", S.commercialAckQuarantine],
  ["commercial_ack_cursor", S.commercialAckCursors],
  ["commercial_submission", S.commercialSubmissions],
  ["commercial_claim_state_history", S.commercialClaimStateHistory],
  ["commercial_claim_line", S.commercialClaimLines],
];

const AFTER_RUN_POINTER: readonly Pass[] = [
  ["commercial_validation_run", S.commercialValidationRuns],
  ["commercial_claim", S.commercialClaims],
  ["commercial_authorization", S.commercialAuthorizations],
  ["commercial_eligibility_check", S.commercialEligibilityCheck],
  ["commercial_payer_enrollment", S.commercialPayerEnrollment],
  ["commercial_contract_rate", S.commercialContractRate],
  ["commercial_payer_route", S.commercialPayerRoute],
  ["commercial_payer_plan", S.commercialPayerPlan],
];

export function createDrizzleCommercialBillingEraseStore(
  db: DbClient,
): CommercialBillingEraseStore {
  return {
    async eraseOrgCommercialBilling({ organizationId }) {
      return db.transaction(async (tx) => {
        const counts: Record<string, number> = {};
        const wipe = async ([name, table]: Pass) => {
          counts[name] = (
            await tx.delete(table).where(eq(table.organizationId, organizationId)).returning()
          ).length;
        };
        for (const pass of BEFORE_RUN_POINTER) await wipe(pass);
        await tx
          .update(S.commercialClaims)
          .set({ latestValidationRunId: null })
          .where(eq(S.commercialClaims.organizationId, organizationId));
        for (const pass of AFTER_RUN_POINTER) await wipe(pass);
        return counts;
      });
    },
  };
}

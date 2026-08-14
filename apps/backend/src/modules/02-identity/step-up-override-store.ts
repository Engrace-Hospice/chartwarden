// apps/backend/src/modules/02-identity/step-up-override-store.ts — the live Drizzle
// `StepUpOverrideStore` over the M2-owned `tenant_step_up_policy_override` table (§3.7, §4.3.2, D9).
//
// AC-03. This is the read that did not exist. `tenant_step_up_policy_override` shipped in migration
// 0006 with RLS and an audit trigger, and nothing has ever read or written it: no Drizzle store, no
// route, no seam. The consequence was not a loose gate but a DEAD one — a tenant who tightened
// step-up for an operation would have had the configuration silently ignored, because M3's
// `step_up_recent` predicate evaluated against the raw platform floor and never consulted the table
// at all. Wiring the read is half of closing that; migration 0211's trigger is the other half.
//
// Runs inside `withOrgContext` so RLS (`tenant_step_up_policy_override_org_isolation`, migration
// 0006) scopes the read by `app.org_id` — an override belonging to another tenant cannot resolve
// here even if the operation key matches.
import type { StepUpOverrideRecord, StepUpOverrideStore } from "@wardenx/auth";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { StepUpFactor } from "@wardenx/types";
import { and, eq } from "drizzle-orm";

/** Build the live override store (org-scoped under RLS). */
export function createDrizzleStepUpOverrideStore(db: DbClient): StepUpOverrideStore {
  return {
    async find({ orgId }, operationKey): Promise<StepUpOverrideRecord | null> {
      if (!orgId || !operationKey) return null; // no scope ⇒ no override ⇒ the floor stands
      // `userId: ""` — this is a policy read on the request's behalf, not an actor action; the
      // audit actor is NULL for it (the withOrgContext convention).
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const rows = await tx
          .select({
            qualifyingFactors: schema.tenantStepUpPolicyOverride.qualifyingFactors,
            maxAgeSec: schema.tenantStepUpPolicyOverride.maxAgeSec,
          })
          .from(schema.tenantStepUpPolicyOverride)
          .where(
            and(
              eq(schema.tenantStepUpPolicyOverride.organizationId, orgId),
              eq(schema.tenantStepUpPolicyOverride.operationKey, operationKey),
            ),
          )
          .limit(1);
        const row = rows[0];
        if (!row) return null;
        return {
          qualifyingFactors: (row.qualifyingFactors ?? []) as readonly StepUpFactor[],
          maxAgeSec: row.maxAgeSec,
        };
      });
    },
  };
}

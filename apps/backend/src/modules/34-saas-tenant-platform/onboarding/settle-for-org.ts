// apps/backend/src/modules/34-saas-tenant-platform/onboarding/settle-for-org.ts — "an organization's onboarding data just
// changed: let the advance pass settle whatever it unlocked" (post-commit, best effort).
//
// The advance pass is keyed by tenant account; a caller that knows only the organization (the tenant's own clearinghouse route
// in M23, which cannot import M34) goes through this. It reads the tenant account under the organization's own RLS scope and
// runs the pass only for a tenant that is still provisioning / onboarding (an active tenant has nothing for the sweep to
// settle). The pass itself is the code the daily sweep runs; a failure is logged by the caller and never fails the change.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { eq } from "drizzle-orm";
import { ONBOARDING_WRITABLE_STATUSES } from "../routes/platform/tenant-onboarding-lock";

export type OnboardingAdvance = (tenant: {
  readonly tenantAccountId: string;
  readonly organizationId: string;
}) => Promise<void>;

export function createSettleOnboardingForOrg(deps: {
  readonly db: DbClient;
  readonly advance: OnboardingAdvance;
  /**
   * Runs for a tenant that is NOT being onboarded (a live one): its sweep has nothing to settle, but a change of clearinghouse
   * still has to reach what follows the choice (the billing service mode of a tenant that switched to outside).
   */
  readonly afterChange?: (organizationId: string) => Promise<void>;
}): (organizationId: string) => Promise<void> {
  return async (organizationId) => {
    const account = await withOrgContext(deps.db, { organizationId, userId: "" }, async (tx) => {
      const [row] = await tx
        .select({ id: schema.tenantAccount.id, status: schema.tenantAccount.status })
        .from(schema.tenantAccount)
        .where(eq(schema.tenantAccount.organizationId, organizationId))
        .limit(1);
      return row ?? null;
    });
    if (!account) return;
    if (!ONBOARDING_WRITABLE_STATUSES.has(account.status)) {
      await deps.afterChange?.(organizationId);
      return;
    }
    await deps.advance({ tenantAccountId: account.id, organizationId });
  };
}

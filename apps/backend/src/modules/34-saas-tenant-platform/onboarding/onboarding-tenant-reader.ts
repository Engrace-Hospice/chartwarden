// apps/backend/src/modules/34-saas-tenant-platform/onboarding/onboarding-tenant-reader.ts — "is this organization's tenant still
// provisioning or onboarding?", the one M34 fact M2's `select-organization` needs to admit a `created` organization's first admin.
//
// M34 owns `tenant_account`; M2 may not read it, so the composition root injects this as a port. It reads under the
// organization's own RLS scope as the tenant role (the same way M2's own status reader does), so it can say nothing about any
// other organization, and it answers only the one boolean: no status, no tenant data.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { eq } from "drizzle-orm";
import { ONBOARDING_WRITABLE_STATUSES } from "../routes/platform/tenant-onboarding-lock";

export interface OnboardingTenantReader {
  isOnboarding(organizationId: string): Promise<boolean>;
}

export function createOnboardingTenantReader(db: DbClient): OnboardingTenantReader {
  return {
    isOnboarding: (organizationId) =>
      withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [account] = await tx
          .select({ status: schema.tenantAccount.status })
          .from(schema.tenantAccount)
          .where(eq(schema.tenantAccount.organizationId, organizationId))
          .limit(1);
        return account !== undefined && ONBOARDING_WRITABLE_STATUSES.has(account.status);
      }),
  };
}

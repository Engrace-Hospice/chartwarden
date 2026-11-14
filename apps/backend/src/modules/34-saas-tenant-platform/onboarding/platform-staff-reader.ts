// apps/backend/src/modules/34-saas-tenant-platform/onboarding/platform-staff-reader.ts — is this user ChartWarden platform staff?
//
// One reader for the wizard's compliance-officer and go-live rules and for the help requests' member check (every operator is an
// active member of every tenant, so "is a member" cannot mean "belongs to the customer"). It asks M1's SECURITY DEFINER holder reader
// (`m34_platform_role_holders`, migration 1097: platform-owned roles only, user ids only) on the caller's own transaction.
import { PLATFORM_GRANTABLE_ROLE_KEYS } from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";

export async function readIsPlatformStaff(tx: DbClient, userId: string): Promise<boolean> {
  const holders = await tx.execute<{ user_id: string }>(
    sql`SELECT user_id FROM m34_platform_role_holders(ARRAY[${sql.join(
      PLATFORM_GRANTABLE_ROLE_KEYS.map((key) => sql`${key}`),
      sql`, `,
    )}]::text[]) WHERE user_id = ${userId}::uuid`,
  );
  return holders.rows.length > 0;
}

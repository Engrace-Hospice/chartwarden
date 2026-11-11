// apps/backend/src/modules/12-dosespot/tenant-config/settled-reader.ts — the onboarding wizard's fact for the e-prescribing step:
// "the org's DoseSpot is settled". M34 may not read M12's tables, so the composition root hands its sweep and wizard this reader
// as a port (the `buildMacFeedConfiguredReader` precedent). The step settles on a LIVE registration ALONE (`liveness.ts`: active, and
// its environment allowed on this deployment, so a sandbox row is not settled while DOSESPOT_SANDBOX_ENABLED is off). The prescriber
// count is shown on the view and does not gate (a prescriber needs a membership, and the first-admin step comes after this one).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { eq } from "drizzle-orm";
import { registrationIsLive } from "./liveness";

const R = schema.dosespotClinicRegistrations;

export function buildDoseSpotSettledReader(
  db: DbClient,
  platformEnv: Readonly<Record<string, string | undefined>>,
): (organizationId: string) => Promise<boolean> {
  return (organizationId) =>
    withOrgContext<DbClient, boolean>(db, { organizationId, userId: "" }, async (tx) => {
      const [row] = await tx
        .select({ status: R.status, environment: R.environment })
        .from(R)
        .where(eq(R.organizationId, organizationId))
        .limit(1);
      return row !== undefined && registrationIsLive(row, platformEnv);
    });
}

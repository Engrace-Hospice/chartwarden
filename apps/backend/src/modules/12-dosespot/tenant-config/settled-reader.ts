// apps/backend/src/modules/12-dosespot/tenant-config/settled-reader.ts — the onboarding wizard's fact for the e-prescribing step:
// "the org's DoseSpot is settled". M34 may not read M12's tables, so the composition root hands its sweep and wizard this reader
// as a port (the `buildMacFeedConfiguredReader` precedent). The step settles on an `active` registration ALONE: the prescriber
// count is shown on the view and does not gate (a prescriber needs a membership, and the first-admin step comes after this one).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { eq } from "drizzle-orm";

const R = schema.dosespotClinicRegistrations;

export function buildDoseSpotSettledReader(
  db: DbClient,
): (organizationId: string) => Promise<boolean> {
  return (organizationId) =>
    withOrgContext<DbClient, boolean>(db, { organizationId, userId: "" }, async (tx) => {
      const [row] = await tx
        .select({ status: R.status })
        .from(R)
        .where(eq(R.organizationId, organizationId))
        .limit(1);
      return row?.status === "active";
    });
}

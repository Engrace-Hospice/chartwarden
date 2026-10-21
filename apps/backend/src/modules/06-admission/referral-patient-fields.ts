// apps/backend/src/modules/06-admission/referral-patient-fields.ts — the patient facts a referral-closing event
// (declined / duplicate / withdrawn) carries so M5 can end the right `admitting_staff` grant.
//
// The grant holder is whoever ran "create patient from intake"; that actor is recorded only on the referral's
// `patient_created` activity row (the referral has no creator column), so it is read from there. Absent for a
// matched (not created) patient or a referral that never resolved one; M5 then falls back to a patient-wide end.
import { type DbClient, schema } from "@chartwarden/db";
import { and, desc, eq } from "drizzle-orm";

const RA = schema.referralActivities;

export interface ReferralPatientFields {
  readonly patientId?: string;
  readonly patientCreatedByUserId?: string;
}

export async function referralPatientFields(
  tx: DbClient,
  referralId: string,
  patientId: string | null | undefined,
): Promise<ReferralPatientFields> {
  if (!patientId) return {};
  const [created] = await tx
    .select({ actorId: RA.actorId })
    .from(RA)
    .where(and(eq(RA.referralId, referralId), eq(RA.action, "patient_created")))
    .orderBy(desc(RA.createdAt))
    .limit(1);
  return created?.actorId ? { patientId, patientCreatedByUserId: created.actorId } : { patientId };
}

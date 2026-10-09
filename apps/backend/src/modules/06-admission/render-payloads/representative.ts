// apps/backend/src/modules/06-admission/render-payloads/representative.ts - who signed for the patient (GAP-033).
// The consent row (M39's published grantor read) names the representative; a user is Foundation, a caregiver is
// M5's, resolved through the render sources' roster seam. Null when nothing resolves - the caller then refuses.
import { type DbClient, schema } from "@wardenx/db";
import { eq } from "drizzle-orm";
import { consentGrantorFacts } from "../../39-consent/grantor-reader";
import type { RenderSourcesPort } from "./sources";

/**
 * The printed name of the REPRESENTATIVE who signed for a patient, from the M39 consent that authorised them. Null
 * when the consent is missing, belongs to another patient, or names no resolvable grantor - the caller then refuses
 * to build the payload rather than print the patient (or a blank) as the signer of a legal acknowledgment.
 */
export async function representativePrintedName(
  tx: DbClient,
  sources: RenderSourcesPort,
  organizationId: string,
  patientId: string,
  consentId: string,
): Promise<string | null> {
  const consent = await consentGrantorFacts(tx, consentId);
  if (!consent || consent.patientId !== patientId) return null;
  if (consent.grantorUserId) {
    const [user] = await tx
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, consent.grantorUserId))
      .limit(1);
    const name = user?.name?.trim();
    if (name) return name;
  }
  if (consent.grantorCaregiverId && sources.caregiverName) {
    const name = await sources.caregiverName(organizationId, patientId, consent.grantorCaregiverId);
    if (name) return name;
  }
  return null;
}

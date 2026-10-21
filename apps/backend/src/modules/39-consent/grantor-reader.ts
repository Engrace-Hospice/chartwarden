// apps/backend/src/modules/39-consent/grantor-reader.ts - the published read of WHO granted a consent (GAP-033).
// M6 prints the representative's name on a notice-of-rights acknowledgment or a revocation; the consent row names
// the grantor, and only M39 reads `consent_record`. Ids only: resolving a name is the grantor's owning module's job
// (a user is Foundation, a caregiver is M5 through its roster seam).
import { type DbClient, schema } from "@chartwarden/db";
import { eq } from "drizzle-orm";

export interface ConsentGrantorFacts {
  readonly patientId: string;
  readonly grantorUserId: string | null;
  readonly grantorCaregiverId: string | null;
}

/** The grantor facts of one consent, read under the caller's tenant transaction (RLS scopes the org). */
export async function consentGrantorFacts(
  tx: DbClient,
  consentId: string,
): Promise<ConsentGrantorFacts | null> {
  const [row] = await tx
    .select({
      patientId: schema.consentRecord.patientId,
      grantorUserId: schema.consentRecord.grantorUserId,
      grantorCaregiverId: schema.consentRecord.grantorCaregiverId,
    })
    .from(schema.consentRecord)
    .where(eq(schema.consentRecord.id, consentId))
    .limit(1);
  return row ?? null;
}

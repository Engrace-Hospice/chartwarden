// apps/backend/src/modules/05-patient/caregiver-user-link.ts - GAP-158 (migration 0462).
//
// The caregiver -> M2 user link and the seam read built on it. A `caregiver` is a person on a patient's roster; the
// portal login that person claims is an M2 user. The link is stamped when a portal invitation issued FOR that
// caregiver is accepted (M31's accept transaction calls `linkCaregiverToUserInTx` through an injected port - M31 never
// writes M5's table), and `PatientCaregiverReader.primaryCaregiverUserId` (the `portal_caregiver_is_primary_or_dpoa`
// ABAC read) resolves the PRIMARY current caregiver's user through it. Before this the reader was a deny-stub
// ("no caregiver->user schema link exists"), so family caregivers could never pass the attestation gate.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { PatientCaregiverReader } from "@wardenx/types";
import { and, eq, isNull } from "drizzle-orm";

export type CaregiverLinkOutcome = "linked" | "already_linked" | "caregiver_not_found" | "conflict";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/**
 * Stamp `caregiver.user_id` inside the CALLER's org transaction (so the link commits with the invitation accept).
 * First-writer-wins and idempotent: re-linking the same user is `already_linked`; a DIFFERENT user is `conflict`
 * (the caller refuses the accept - one caregiver record, one login). The update asserts its row count.
 */
export async function linkCaregiverToUserInTx(
  tx: unknown,
  input: { readonly organizationId: string; readonly caregiverId: string; readonly userId: string },
): Promise<CaregiverLinkOutcome> {
  const db = tx as Tx;
  const C = schema.caregivers;
  const claimed = await db
    .update(C)
    .set({ userId: input.userId })
    .where(
      and(
        eq(C.id, input.caregiverId),
        eq(C.organizationId, input.organizationId),
        isNull(C.userId),
      ),
    )
    .returning({ id: C.id });
  if (claimed.length === 1) return "linked";
  const [existing] = await db
    .select({ userId: C.userId })
    .from(C)
    .where(and(eq(C.id, input.caregiverId), eq(C.organizationId, input.organizationId)))
    .limit(1);
  if (!existing) return "caregiver_not_found";
  return existing.userId === input.userId ? "already_linked" : "conflict";
}

/** The M5 `PatientCaregiverReader` seam: the M2 user of the patient's PRIMARY current caregiver, or null. */
export function buildPatientCaregiverReader(db: DbClient): PatientCaregiverReader {
  const LINK = schema.patientCaregivers;
  const C = schema.caregivers;
  return {
    async primaryCaregiverUserId(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "system" }, async (tx) => {
        const [row] = await tx
          .select({ userId: C.userId })
          .from(LINK)
          .innerJoin(C, eq(C.id, LINK.caregiverId))
          .where(
            and(
              eq(LINK.organizationId, organizationId),
              eq(LINK.patientId, patientId),
              eq(LINK.isPrimary, true),
              isNull(LINK.involvementTo),
            ),
          )
          .limit(1);
        return row?.userId ?? null;
      });
    },
  };
}

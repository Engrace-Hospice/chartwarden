// M41 -> M25 CommercialClaimReader seam (#725, ADR-0100 D8). Read-only, org-scoped (RLS via withOrgContext) AND
// provider-entity-scoped AND payer-scoped: a claim is a candidate only when its plan's payer is the advice's payer.
// Only claims the payer could have adjudicated (sent to the clearinghouse) are candidates; a draft, rejected or void
// claim never receives a payment.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, inArray } from "drizzle-orm";
import { registerSeam } from "../../../bootstrap/index";

/** States in which a payment can legitimately arrive. */
const PAYABLE_STATES = ["submitted", "ack_pending", "accepted"] as const;

export interface CommercialClaimReader {
  candidatesForLine(
    orgId: string,
    providerEntityId: string,
    payerId: string,
    keys: { claimControlNumber?: string },
  ): Promise<
    Array<{ claimId: string; claimControlNumber: string; serviceFrom: string; serviceTo: string }>
  >;
  patientIdForClaim(orgId: string, claimId: string): Promise<string | null>;
}

const actorOf = (organizationId: string) => ({ organizationId, userId: "" });

export function buildCommercialClaimReader(db: DbClient): CommercialClaimReader {
  return {
    async candidatesForLine(orgId, providerEntityId, payerId, keys) {
      if (!keys.claimControlNumber) return [];
      return withOrgContext(db, actorOf(orgId), async (tx) => {
        const C = schema.commercialClaims;
        const P = schema.commercialPayerPlan;
        return tx
          .select({
            claimId: C.id,
            claimControlNumber: C.claimControlNumber,
            serviceFrom: C.serviceFrom,
            serviceTo: C.serviceTo,
          })
          .from(C)
          .innerJoin(P, and(eq(P.id, C.planId), eq(P.organizationId, C.organizationId)))
          .where(
            and(
              eq(C.organizationId, orgId),
              eq(C.providerEntityId, providerEntityId),
              eq(P.payerId, payerId),
              eq(C.claimControlNumber, keys.claimControlNumber as string),
              inArray(C.state, [...PAYABLE_STATES]),
            ),
          );
      });
    },
    async patientIdForClaim(orgId, claimId) {
      return withOrgContext(db, actorOf(orgId), async (tx) => {
        const C = schema.commercialClaims;
        const rows = await tx
          .select({ patientId: C.patientId })
          .from(C)
          .where(and(eq(C.id, claimId), eq(C.organizationId, orgId)))
          .limit(1);
        return rows[0]?.patientId ?? null;
      });
    },
  };
}

/** Register the seam at boot (no db: the M1 deny-stub stands and M25 degrades to manual review). */
export function registerM41PublishedSeams(db: DbClient | undefined): void {
  if (!db) return;
  registerSeam("CommercialClaimReader", buildCommercialClaimReader(db));
}

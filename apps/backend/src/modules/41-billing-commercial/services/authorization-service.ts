// apps/backend/src/modules/41-billing-commercial/services/authorization-service.ts — record and change pre-authorizations
// (issue #722). A pre-authorization is the evidence the `authorization_on_file` rule reads; recording or voiding one does not
// touch any claim, a re-validation picks the change up. The authorization number is an identifier: it is stored in its own
// column, scrubbed from the row-level audit event, and never placed in a log, an outbox payload or a validation message.
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  type CommercialAuthorizationStatus,
  type CommercialHospiceLevelOfCare,
  ConflictError,
  NotFoundError,
} from "@chartwarden/types";
import { and, desc, eq } from "drizzle-orm";
import type { CommercialActor, CommercialDb, CommercialTx } from "./types";

export interface RecordAuthorizationInput {
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly planId: string;
  readonly authorizationNumber: string;
  readonly levelOfCare?: CommercialHospiceLevelOfCare | null;
  readonly obtainedOn: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null;
}

export interface AuthorizationView {
  readonly id: string;
  readonly patientId: string;
  readonly planId: string;
  readonly levelOfCare: string | null;
  readonly status: string;
  readonly obtainedOn: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

const view = (a: typeof schema.commercialAuthorizations.$inferSelect): AuthorizationView => ({
  id: a.id,
  patientId: a.patientId,
  planId: a.planId,
  levelOfCare: a.levelOfCare,
  status: a.status,
  obtainedOn: a.obtainedOn,
  effectiveFrom: a.effectiveFrom,
  effectiveTo: a.effectiveTo,
});

export interface CommercialAuthorizationService {
  record(actor: CommercialActor, input: RecordAuthorizationInput): Promise<AuthorizationView>;
  setStatus(
    actor: CommercialActor,
    id: string,
    status: Exclude<CommercialAuthorizationStatus, "approved">,
  ): Promise<AuthorizationView>;
  listForPatient(
    actor: Pick<CommercialActor, "organizationId" | "userId">,
    patientId: string,
  ): Promise<AuthorizationView[]>;
}

export function buildCommercialAuthorizationService(
  db: CommercialDb,
  now: () => Date = () => new Date(),
): CommercialAuthorizationService {
  const inOrg = <T>(
    actor: Pick<CommercialActor, "organizationId" | "userId">,
    fn: (tx: CommercialTx) => Promise<T>,
  ): Promise<T> =>
    withOrgContext(db, { organizationId: actor.organizationId, userId: actor.userId }, fn);
  const refuseAi = (actor: CommercialActor): void => {
    if (actor.actorKind.startsWith("ai_")) {
      throw new ChartWardenError(
        "AI_ACTOR_FORBIDDEN",
        "AI actors may not change a billing record",
        403,
      );
    }
  };

  return {
    async record(actor, input) {
      refuseAi(actor);
      if (input.effectiveTo != null && input.effectiveTo < input.effectiveFrom) {
        throw new ChartWardenError("VALIDATION_FAILED", "effectiveTo precedes effectiveFrom", 422);
      }
      return inOrg(actor, async (tx) => {
        const [plan] = await tx
          .select({ id: schema.commercialPayerPlan.id })
          .from(schema.commercialPayerPlan)
          .where(
            and(
              eq(schema.commercialPayerPlan.id, input.planId),
              eq(schema.commercialPayerPlan.organizationId, actor.organizationId),
            ),
          );
        if (!plan) throw new NotFoundError("payer plan");
        const [dup] = await tx
          .select({ id: schema.commercialAuthorizations.id })
          .from(schema.commercialAuthorizations)
          .where(
            and(
              eq(schema.commercialAuthorizations.planId, input.planId),
              eq(schema.commercialAuthorizations.patientId, input.patientId),
              eq(schema.commercialAuthorizations.authorizationNumber, input.authorizationNumber),
            ),
          );
        if (dup)
          throw new ConflictError(
            "this authorization number is already recorded for the patient and plan",
          );
        const [row] = await tx
          .insert(schema.commercialAuthorizations)
          .values({
            organizationId: actor.organizationId,
            providerEntityId: input.providerEntityId,
            patientId: input.patientId,
            planId: input.planId,
            authorizationNumber: input.authorizationNumber,
            levelOfCare: input.levelOfCare ?? null,
            obtainedOn: input.obtainedOn,
            effectiveFrom: input.effectiveFrom,
            effectiveTo: input.effectiveTo ?? null,
            createdByMembershipId: actor.membershipId,
          })
          .returning();
        if (!row) throw new Error("authorization insert returned no row");
        return view(row);
      });
    },

    async setStatus(actor, id, status) {
      refuseAi(actor);
      return inOrg(actor, async (tx) => {
        const [row] = await tx
          .update(schema.commercialAuthorizations)
          .set({ status, updatedAt: now() })
          .where(
            and(
              eq(schema.commercialAuthorizations.id, id),
              eq(schema.commercialAuthorizations.organizationId, actor.organizationId),
            ),
          )
          .returning();
        if (!row) throw new NotFoundError("authorization");
        return view(row);
      });
    },

    async listForPatient(actor, patientId) {
      return inOrg(actor, async (tx) => {
        const rows = await tx
          .select()
          .from(schema.commercialAuthorizations)
          .where(
            and(
              eq(schema.commercialAuthorizations.patientId, patientId),
              eq(schema.commercialAuthorizations.organizationId, actor.organizationId),
            ),
          )
          .orderBy(desc(schema.commercialAuthorizations.effectiveFrom));
        return rows.map(view);
      });
    },
  };
}

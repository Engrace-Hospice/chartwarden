// apps/backend/src/modules/41-billing-commercial/services/authorization-service.ts — record and change pre-authorizations
// (issue #722). A pre-authorization is the evidence the `authorization_on_file` rule reads; recording or voiding one does not
// touch any claim, a re-validation picks the change up. The authorization number is an identifier: it is stored in its own
// column, scrubbed from the row-level audit event, and never placed in a log, an outbox payload or a validation message.
//
// SCOPE: every operation checks the DATA against the actor, not just the entity named in the request (scope-guard.ts): the
// provider entity is in the actor's billing scope, the patient is in their caseload, and the patient's admission belongs to that
// entity. Reads filter on the provider entity as well as the patient.
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  type CommercialAuthorizationStatus,
  type CommercialHospiceLevelOfCare,
  NotFoundError,
} from "@chartwarden/types";
import { and, desc, eq } from "drizzle-orm";
import { conflictOnUnique } from "./db-errors";
import {
  assertPatientBoundToProvider,
  assertPatientReachable,
  assertProviderInScope,
  assertRowReachable,
} from "./scope-guard";
import type { CommercialActor, CommercialClaimSeams, CommercialDb, CommercialTx } from "./types";
import { evaluateClaim } from "./validation-runner";

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

type ReadActor = Pick<CommercialActor, "organizationId" | "userId" | "billingScope">;

export interface CommercialAuthorizationService {
  record(actor: CommercialActor, input: RecordAuthorizationInput): Promise<AuthorizationView>;
  setStatus(
    actor: CommercialActor,
    id: string,
    status: Exclude<CommercialAuthorizationStatus, "approved">,
  ): Promise<AuthorizationView>;
  listForPatient(
    actor: ReadActor,
    providerEntityId: string,
    patientId: string,
  ): Promise<AuthorizationView[]>;
}

/** The authorization service needs only the admission and caseload seams of the claim lane. */
export type AuthorizationSeams = Pick<CommercialClaimSeams, "admission" | "caseload">;

/** A wide window: the patient's most recent admission, whatever its dates, binds the patient to its provider entity. */
const ANY_TIME = { from: "1900-01-01", to: "9999-12-31" } as const;

export function buildCommercialAuthorizationService(
  db: CommercialDb,
  seams: AuthorizationSeams,
  now: () => Date = () => new Date(),
): CommercialAuthorizationService {
  const inOrg = <T>(actor: ReadActor, fn: (tx: CommercialTx) => Promise<T>): Promise<T> =>
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
  const assertReachable = async (
    actor: ReadActor,
    providerEntityId: string,
    patientId: string,
  ): Promise<void> => {
    assertProviderInScope(actor, providerEntityId);
    await assertPatientReachable(actor, seams.caseload, patientId);
    await assertPatientBoundToProvider(
      seams.admission,
      actor.organizationId,
      patientId,
      providerEntityId,
      ANY_TIME,
    );
  };

  return {
    async record(actor, input) {
      refuseAi(actor);
      if (input.effectiveTo != null && input.effectiveTo < input.effectiveFrom) {
        throw new ChartWardenError("VALIDATION_FAILED", "effectiveTo precedes effectiveFrom", 422);
      }
      await assertReachable(actor, input.providerEntityId, input.patientId);
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
        // The unique key (org, plan, patient, number) is the backstop: a concurrent duplicate is a 409, not a 500.
        const row = await conflictOnUnique(
          "this authorization number is already recorded for the patient and plan",
          async () =>
            (
              await tx
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
                .returning()
            )[0],
        );
        if (!row) throw new Error("authorization insert returned no row");
        return view(row);
      });
    },

    async setStatus(actor, id, status) {
      refuseAi(actor);
      return inOrg(actor, async (tx) => {
        const [existing] = await tx
          .select()
          .from(schema.commercialAuthorizations)
          .where(
            and(
              eq(schema.commercialAuthorizations.id, id),
              eq(schema.commercialAuthorizations.organizationId, actor.organizationId),
            ),
          );
        if (!existing) throw new NotFoundError("authorization");
        await assertRowReachable(actor, seams.caseload, existing);
        // approved -> denied | voided only: a denied or voided authorization is final (a new one is recorded instead).
        if (existing.status !== "approved") {
          throw new ChartWardenError(
            "CONFLICT",
            `this authorization is already ${existing.status}; record a new one instead`,
            409,
          );
        }
        const [row] = await tx
          .update(schema.commercialAuthorizations)
          .set({ status, updatedAt: now() })
          .where(
            and(
              eq(schema.commercialAuthorizations.id, id),
              eq(schema.commercialAuthorizations.organizationId, actor.organizationId),
              eq(schema.commercialAuthorizations.status, "approved"),
            ),
          )
          .returning();
        if (!row) throw new NotFoundError("authorization");
        // A ready claim that depended on this authorization falls back to draft in the same transaction (its readiness event
        // was already published; nothing may keep trusting state=ready after the evidence is gone).
        const dependents = await tx
          .select()
          .from(schema.commercialClaims)
          .where(
            and(
              eq(schema.commercialClaims.organizationId, actor.organizationId),
              eq(schema.commercialClaims.providerEntityId, row.providerEntityId),
              eq(schema.commercialClaims.patientId, row.patientId),
              eq(schema.commercialClaims.planId, row.planId),
              eq(schema.commercialClaims.state, "ready"),
            ),
          )
          .for("update");
        for (const claim of dependents) {
          if (!(await evaluateClaim(tx, claim)).some((r) => r.blocking)) continue;
          await tx
            .update(schema.commercialClaims)
            .set({ state: "draft", readyAt: null, updatedAt: now() })
            .where(eq(schema.commercialClaims.id, claim.id));
          await tx.insert(schema.commercialClaimStateHistory).values({
            organizationId: actor.organizationId,
            providerEntityId: claim.providerEntityId,
            locationId: claim.locationId,
            claimId: claim.id,
            fromState: "ready",
            toState: "draft",
            actorKind: actor.actorKind,
            actorMembershipId: actor.membershipId,
          });
        }
        return view(row);
      });
    },

    async listForPatient(actor, providerEntityId, patientId) {
      await assertReachable(actor, providerEntityId, patientId);
      return inOrg(actor, async (tx) => {
        const rows = await tx
          .select()
          .from(schema.commercialAuthorizations)
          .where(
            and(
              eq(schema.commercialAuthorizations.patientId, patientId),
              eq(schema.commercialAuthorizations.providerEntityId, providerEntityId),
              eq(schema.commercialAuthorizations.organizationId, actor.organizationId),
            ),
          )
          .orderBy(desc(schema.commercialAuthorizations.effectiveFrom));
        return rows.map(view);
      });
    },
  };
}

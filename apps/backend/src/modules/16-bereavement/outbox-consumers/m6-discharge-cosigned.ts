// apps/backend/src/modules/16-bereavement/outbox-consumers/m6-discharge-cosigned.ts — the D18 gate release
// (M16 spec §2.2 `receiveCosign`, §2.6, §4.3.1 `receiveCosignAndReleaseGate`).
//
// WHAT THIS CLOSES (F-227, #248). `m6.discharge.cosigned` sat declared-but-unbound for the life of the module
// behind a "payload mismatch" finding (F-094/F-159/F-167): the catalogued payload was the for-cause cosign's
// `{dischargeEventId, medicalDirectorCosignedAt}` while `decideCosignReceipt` needs `{sourceProposalId,
// cosignedAt, medicalDirectorMembershipId}`, and `discharge_event` had no source/cosign columns to ever supply
// them. M6 now records an HL7-external death with `source='hl7_external'` + `source_proposal_id` +
// `cosign_required` (W-M6-31) and its route-40 cosign attests it, publishing `m6.discharge.cosigned` widened
// additively with `sourceProposalId` + `medicalDirectorMembershipId`. M16's `death-discharge.ts` no longer
// fabricates `sourceProposalId` from the admission id: the same M6 seam row carries the real one.
//
// WHICH DELIVERIES APPLY. Only a cosign that names a `sourceProposalId`. A for-cause cosign (route 40 over a
// `pending_cosign` row) carries none and is not an external-source plan's gate — it is a no-op here.
//
// ORDERING. Two legal orderings of the two M6 events: (a) `m6.bereavement.eligible` first — the plan exists with
// `cosignStatus='pending'` and this consumer releases it; (b) the cosign first — no plan yet, this is a no-op and
// the later intake reads the `cosigned` fact (+ `cosignedAt`/membership) straight off M6's seam row. Neither loses
// the release. A plan that is already `cosigned`, or whose stored `sourceProposalId` differs, is a no-op via
// `decideCosignReceipt` (`applyCosignReceipt` IS the idempotency check) — a redelivery never restamps `cosignedAt`.
//
// NOT A REQUEST. The relay tick has no ambient request context: every read/write runs in an org-explicit
// `withOrgContext`, and the publisher is the bound M16 catalog-validating one.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { IsoInstant } from "@wardenx/types";
import { and, eq, sql } from "drizzle-orm";
import { decideCosignReceipt } from "../consumers/index";
import { transitionBereavementPlan } from "../lifecycle/index";
import { runEffects } from "../routes/effects-runner";
import type { WriteOutboxPort } from "../routes/write-service";

const PLAN = schema.bereavementPlan;

/** §3.3 — a consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

export const M16_DISCHARGE_COSIGNED_CONSUMER = {
  eventName: "m6.discharge.cosigned",
  consumerName: "m16.m6-discharge-cosigned",
} as const;

export interface DischargeCosignedDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s `m16.*` against the boot catalog and rolls the tx back on a mismatch. */
  readonly outbox: WriteOutboxPort;
}

function factsOf(payload: unknown): {
  admissionId: string;
  sourceProposalId: string | null;
  cosignedAt: IsoInstant;
  medicalDirectorMembershipId: string | null;
} {
  const p = (payload ?? {}) as Record<string, unknown>;
  const str = (key: string): string | null =>
    typeof p[key] === "string" && (p[key] as string).length > 0 ? (p[key] as string) : null;
  const admissionId = str("admissionId");
  const cosignedAt = str("medicalDirectorCosignedAt");
  if (admissionId === null || cosignedAt === null) {
    throw new Error(
      `${M16_DISCHARGE_COSIGNED_CONSUMER.consumerName}: payload needs admissionId + medicalDirectorCosignedAt`,
    );
  }
  return {
    admissionId,
    sourceProposalId: str("sourceProposalId"),
    cosignedAt: cosignedAt as IsoInstant,
    medicalDirectorMembershipId: str("medicalDirectorMembershipId"),
  };
}

/**
 * M16's live `m6.discharge.cosigned` binding — releases the D18 external-source first-contact gate.
 * Idempotent: the dispatcher's `(eventId, consumerName)` receipt, and — on a redelivery that reaches the
 * handler — `decideCosignReceipt`'s already-`cosigned` no-op, with the plan row locked `FOR UPDATE` so two
 * concurrent deliveries serialize rather than both applying.
 */
export function buildM16DischargeCosignedConsumer(deps: DischargeCosignedDeps) {
  return {
    consumerName: M16_DISCHARGE_COSIGNED_CONSUMER.consumerName,
    consumerModule: "m16" as const,
    eventTypes: [M16_DISCHARGE_COSIGNED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      // A for-cause cosign (no source proposal) is not an external-source gate.
      if (facts.sourceProposalId === null) return;
      // An external-source cosign without the attesting director cannot release a gate whose whole point
      // is WHO attested; dead-letter for a human rather than stamp an anonymous attestation.
      if (facts.medicalDirectorMembershipId === null) {
        throw new Error(
          `${M16_DISCHARGE_COSIGNED_CONSUMER.consumerName}: an external-source cosign names no medicalDirectorMembershipId`,
        );
      }
      const sourceProposalId = facts.sourceProposalId;
      const medicalDirectorMembershipId = facts.medicalDirectorMembershipId;
      const organizationId = event.organizationId;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const [plan] = await tx
            .select()
            .from(PLAN)
            .where(
              and(eq(PLAN.organizationId, organizationId), eq(PLAN.admissionId, facts.admissionId)),
            )
            .for("update")
            .limit(1);
          // Ordering (b): no plan yet — the intake will read the cosigned fact off M6's seam row.
          if (plan === undefined) return;

          const action = decideCosignReceipt(
            (plan.externalSourceMetadata ?? null) as Parameters<typeof decideCosignReceipt>[0],
            {
              sourceProposalId,
              cosignedAt: facts.cosignedAt,
              medicalDirectorMembershipId,
            },
          );
          if (action.kind === "no_op") return;

          const at = new Date();
          // State-preserving (D18): `receiveCosign` is legal on every non-closed state; on a closed plan the
          // machine throws ILLEGAL_TRANSITION, which dead-letters for a human — a closed program's gate
          // is moot, and silently stamping it would rewrite a closed record.
          const transition = transitionBereavementPlan(plan.status, {
            type: "receiveCosign",
            metadata: action.metadata,
          });
          const patch = await runEffects(tx, transition.effects, {
            organizationId,
            at,
            outbox: deps.outbox,
            aggregateKind: "bereavement_plan",
            aggregateId: plan.id,
            payloads: {
              "m16.bereavement.external_source_cosign_received": {
                planId: plan.id,
                organizationId,
                cosignedAt: facts.cosignedAt,
                medicalDirectorMembershipId,
              },
            },
          });
          await tx
            .update(PLAN)
            .set({
              externalSourceMetadata: patch.externalSourceMetadata ?? action.metadata,
              version: sql`${PLAN.version} + 1`,
              updatedAt: at,
            })
            .where(eq(PLAN.id, plan.id));
        },
      );
    },
  };
}

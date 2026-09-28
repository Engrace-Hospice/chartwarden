// apps/backend/src/modules/13-emar/outbox-consumers/m6-admission-discharged-cascade.ts — the §2.5/§2.7 D14
// admission-discharge cascade, live for the first time (F-155, #248).
//
// `planDischargeCascade` (`@wardenx/emar`, `cascade/discharge-cascade.ts`) has been a complete, pure,
// unit-tested planner since M13-T05, and `M13_OUTBOX_SUBSCRIPTIONS` (`consumers/index.ts`) has named
// `m6.admission.discharged` with a real consumer (`m13.admission-discharged-cascade`) since the list was
// written — nothing has ever bound it. One layer down: `scheduled_dose.status`/`cancellation_reason` and
// `comfort_kit_deployment.disposal_status`/`return_required_at` have never been written by a discharge
// anywhere in this repository, so every future dose on a discharged admission stayed `pending` forever
// (a phantom administration slot the missed-dose sweep would eventually — wrongly — flag), and every
// active comfort-kit deployment on a discharged admission stayed `deployed` forever (never surfacing the
// §2.7 return obligation to M21).
//
// `m6.admission.discharged`'s catalogued payload (`events-by-m6.ts`) is `{admissionId, reason,
// dischargeDate}` — no `patientId`. M13's manifest `dependsOn` is `[1, 12, 36, 38]`, NOT 6, so this
// consumer cannot import M6's seam directly: `resolveAdmission` is an injected dependency the composition
// root satisfies with M6's org-explicit `admissionSchedulingContextForOrg` (the §4.7 seam pins the tenant
// from the ambient request scope and a relay tick is not a request — the F-105/F-150/F-152 precedent),
// the exact shape `outbox-consumers/m6-reconciliation-triggers.ts` already established for this same
// module boundary.
//
// NO REASON FILTER: unlike M16's death-only secondary verifier on the SAME event, this cascade fires for
// EVERY discharge reason — `planDischargeCascade`'s own header says so explicitly ("death, revocation,
// transfer-out"), because a future dose or an active comfort kit is equally stale regardless of why the
// admission ended.
//
// IDEMPOTENCY WITHOUT A VERSION COLUMN: neither `scheduled_dose` nor `comfort_kit_deployment` carries a
// `version` column, so each write conditions its `WHERE` on the SAME state predicate the SELECT used to
// find the candidate rows (`status = 'pending'` / `disposal_status = 'deployed' AND return_required_at IS
// NULL`) rather than on `id` alone — the optimistic-concurrency-without-a-version-column shape: a second
// concurrent tick's UPDATE matches zero rows for anything the first tick already claimed, so a lost race
// is a silent no-op rather than a double-cancellation or a double return-required emission. A genuine
// redelivery of the same event, after the first delivery committed, finds nothing left to act on either —
// `planDischargeCascade`'s own doc comment: "re-running with the same already-cancelled doses /
// already-returned kits yields an empty plan."
//
// A consumer-driven write names no acting membership (F-102's `CONSUMER_USER_ID` convention) — there is
// none to name here regardless: neither table carries an actor column for this transition
// (`scheduled_dose` has no actor column at all; `comfort_kit_deployment.deployed_by_membership_id` is the
// DEPLOYMENT actor, set once at deploy time, never touched by a return-required flip).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { planDischargeCascade } from "@wardenx/emar";
import type { AdmissionId, IsoInstant, PatientId } from "@wardenx/types";
import { and, eq, gt } from "drizzle-orm";
import type { EmarWriteOutboxPort } from "../emar-route-service-db";

const DOSE = schema.scheduledDoses;
const KIT = schema.comfortKitDeployments;

export const M13_ADMISSION_DISCHARGED_CASCADE_CONSUMER = {
  eventName: "m6.admission.discharged",
  consumerName: "m13.admission-discharged-cascade",
} as const;

/** The admission facts M6 supplies (org-explicit read, injected — M13 does not depend on M6). Mirrors
 *  `m6-reconciliation-triggers.ts`'s `AdmissionAnchor` — only `patientId` is actually read here. */
export interface DischargeCascadeAdmissionAnchor {
  readonly patientId: PatientId;
}

export interface DischargeCascadeConsumerDeps {
  readonly db: DbClient;
  readonly outbox: EmarWriteOutboxPort;
  readonly resolveAdmission: (
    organizationId: string,
    admissionId: string,
  ) => Promise<DischargeCascadeAdmissionAnchor | null>;
}

function factsOf(payload: unknown): { admissionId: AdmissionId; dischargeAt: IsoInstant } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const admissionId = p.admissionId;
  const dischargeDate = p.dischargeDate;
  if (typeof admissionId !== "string" || admissionId.length === 0) {
    throw new Error(
      `${M13_ADMISSION_DISCHARGED_CASCADE_CONSUMER.consumerName}: payload has no admissionId`,
    );
  }
  if (typeof dischargeDate !== "string" || dischargeDate.length === 0) {
    throw new Error(
      `${M13_ADMISSION_DISCHARGED_CASCADE_CONSUMER.consumerName}: payload has no dischargeDate`,
    );
  }
  return { admissionId: admissionId as AdmissionId, dischargeAt: dischargeDate as IsoInstant };
}

/**
 * M13's live `m6.admission.discharged` binding (§2.5/§2.7 D14). Cancels every future pending scheduled
 * dose and flags every still-deployed comfort kit for return. Fires for every discharge reason (death,
 * revocation, transfer-out) — no `reason` filter.
 */
export function buildM13AdmissionDischargedCascadeConsumer(deps: DischargeCascadeConsumerDeps) {
  return {
    consumerName: M13_ADMISSION_DISCHARGED_CASCADE_CONSUMER.consumerName,
    consumerModule: "m13" as const,
    eventTypes: [M13_ADMISSION_DISCHARGED_CASCADE_CONSUMER.eventName] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;

      const anchor = await deps.resolveAdmission(organizationId, facts.admissionId);
      if (!anchor) {
        throw new Error(
          `${M13_ADMISSION_DISCHARGED_CASCADE_CONSUMER.consumerName}: no M6 admission context for ${facts.admissionId}`,
        );
      }

      await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as DbClient;

        const candidateDoses = await tx
          .select({
            id: DOSE.id,
            medicationOrderId: DOSE.medicationOrderId,
            dueAt: DOSE.dueAt,
            status: DOSE.status,
          })
          .from(DOSE)
          .where(
            and(
              eq(DOSE.organizationId, organizationId),
              eq(DOSE.admissionId, facts.admissionId),
              eq(DOSE.status, "pending"),
              gt(DOSE.dueAt, new Date(facts.dischargeAt)),
            ),
          );

        const candidateDeployments = await tx
          .select({
            id: KIT.id,
            disposalStatus: KIT.disposalStatus,
            returnRequiredAt: KIT.returnRequiredAt,
          })
          .from(KIT)
          .where(
            and(
              eq(KIT.organizationId, organizationId),
              eq(KIT.admissionId, facts.admissionId),
              eq(KIT.disposalStatus, "deployed"),
            ),
          );

        const plan = planDischargeCascade({
          patientId: anchor.patientId,
          admissionId: facts.admissionId,
          dischargeAt: facts.dischargeAt,
          sourceEventId: event.id,
          source: "admission_discharged",
          scheduledDoses: candidateDoses.map((d) => ({
            scheduledDoseId: d.id as never,
            medicationOrderId: d.medicationOrderId as never,
            dueAt: d.dueAt.toISOString() as never,
            status: d.status as never,
          })),
          activeDeployments: candidateDeployments.map((k) => ({
            deploymentId: k.id as never,
            disposalStatus: k.disposalStatus,
            returnRequiredAt: k.returnRequiredAt ? (k.returnRequiredAt.toISOString() as never) : null,
          })),
        });

        for (const cancellation of plan.cancellations) {
          const [updated] = await tx
            .update(DOSE)
            .set({
              status: "cancelled",
              cancellationReason: cancellation.cancellationReason,
              cancellationSourceEventId: cancellation.sourceEventId,
              cancelledAt: new Date(),
            })
            .where(and(eq(DOSE.id, cancellation.scheduledDoseId), eq(DOSE.status, "pending")))
            .returning({ id: DOSE.id });
          if (!updated) continue; // lost a race, or already cancelled by a redelivery — no-op
          await deps.outbox.publish(tx, {
            eventName: "m13.scheduled_dose.cancelled",
            organizationId,
            aggregateKind: "scheduled_dose",
            aggregateId: cancellation.scheduledDoseId,
            payload: {
              scheduledDoseId: cancellation.scheduledDoseId,
              medicationOrderId: cancellation.medicationOrderId,
              cancellationReason: cancellation.cancellationReason,
              sourceEventId: cancellation.sourceEventId,
            },
          });
        }

        for (const returnRequired of plan.returnRequired) {
          const [updated] = await tx
            .update(KIT)
            .set({
              disposalStatus: "return_required",
              returnRequiredAt: new Date(returnRequired.returnRequiredAt),
            })
            .where(and(eq(KIT.id, returnRequired.deploymentId), eq(KIT.disposalStatus, "deployed")))
            .returning({ id: KIT.id });
          if (!updated) continue; // lost a race, or already flagged by a redelivery — no-op
          await deps.outbox.publish(tx, {
            eventName: "m13.comfort_kit.return_required",
            organizationId,
            aggregateKind: "comfort_kit_deployment",
            aggregateId: returnRequired.deploymentId,
            payload: {
              deploymentId: returnRequired.deploymentId,
              patientId: returnRequired.patientId,
              admissionId: returnRequired.admissionId,
              returnRequiredAt: returnRequired.returnRequiredAt,
            },
          });
        }
      });
    },
  };
}

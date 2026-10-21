// apps/backend/src/modules/05-patient/outbox-consumers/m6-admission-activated.ts — the §3.3 tenancy-
// column denormalization M5's own schema has always documented and nothing has ever written (F-152,
// #248).
//
// `patient.provider_entity_id` / `patient.location_id` carry the comment "nullable — until admission"
// (ARCH-011 / M05-F04, `patients.ts`) — a patient chart is org-level until an admission activates, and
// these two columns are the hot-path-join denormalization of "which provider entity/location is this
// patient currently under." `m6.admission.activated` has declared `m5` as a consumer since the catalog
// existed; there has never been a write path anywhere in this repository that sets either column on
// `patient` — not M5's own routes, not a seed, not a test.
//
// SCOPE, DELIBERATELY NARROW: the group's own reason text says this denormalizes "onto every
// patient-scoped child table" — over a dozen tables (`patient_address`, `patient_phone`, `patient_payer`,
// …) carry their own `provider_entity_id`. This consumer touches ONLY the `patient` row itself, the one
// column pair whose schema comment unambiguously states the "nullable until admission" contract. Whether
// activation should retroactively cascade onto already-existing child rows — created before this
// admission, possibly under a DIFFERENT prior admission's provider entity — is a separate, undecided
// product question this build does not guess at: overwriting a child row's own provider-entity context
// could silently misattribute a historical address/payer/phone record to the wrong CCN for billing or
// compliance purposes. Each child table's own write path is presumably responsible for its own value at
// ITS OWN creation time.
//
// CROSS-MODULE BOUNDARY: M5's manifest `dependsOn` is `[1, 2, 3, 4, 36, 38, 40]` — it does NOT include 6
// (Admission), so this consumer cannot import M6's module directly (`arch:boundaries` would refuse it).
// It resolves the fact through M6's already-registered `AdmissionStatusReader` seam
// (`getAdmissionSiting`), the `m6-discharge-death.ts` precedent one file over: "no `dependsOn` edge
// required — seam/outbox consumption is runtime-resolved, ADR-0005 D1." `getAdmissionSiting` is
// ORG-EXPLICIT (`organizationId` is a parameter, not read off ambient request context) and its Drizzle
// backing opens a plain `withOrgContext` — unlike M6's §4.7 id-keyed seam methods, which open
// `withOrgContextFromRequest` and are documented elsewhere in this codebase as unsafe from a relay tick,
// `getAdmissionSiting` was built for exactly this (M14/M30 queue and dashboard reads) and is safe here.
//
// STATUS (§2.4.1): the same delivery also applies the `prospective → active` / `discharged → active`
// edges ("admission approved (M6)" / "re-admission") — nothing else in the repository ever did, so every
// admitted patient stayed `prospective` and the death cascade dead-lettered on them. `active`/`on_hold`/
// `deceased`/`merged` rows keep their status. A redelivery finds `active` and emits nothing.
//
// IDEMPOTENT BY CONSTRUCTION: every delivery re-reads the admission's current siting and re-applies the
// same UPDATE: a redelivery is a no-op write, and a later admission activating for the same patient
// (re-admission at a different provider entity) correctly overwrites the earlier value with the
// currently-true one — there is no ordering hazard to guard against beyond what the outbox already
// guarantees (per-aggregate in-order delivery).
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { eq } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";
import { endAdmittingAssignments } from "../assignments-db";
import type { M5OutboxPort } from "../deceased-db";
import {
  type PatientStatus,
  transitionPatientOnAdmissionActivated,
} from "../lifecycle/admission-activation";
import { activationPromotesToActive } from "../patient-status-transitions";

const P = schema.patients;

/** §3.3 — a consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

export const M5_ADMISSION_SITING_CONSUMER = {
  eventName: "m6.admission.activated",
  consumerName: "m5.m6-admission-activated",
} as const;

export interface AdmissionSitingDeps {
  readonly db: DbClient;
  /** Emits `m5.patient.status_changed` when the activation promotes the patient (§2.4.1). */
  /** M5's catalog-validating transactional outbox publisher. */
  readonly outbox: M5OutboxPort;
}

interface AdmissionActivatedPayload {
  readonly admissionId: string;
  readonly patientId: string;
}

function factsOf(payload: unknown): AdmissionActivatedPayload {
  const p = (payload ?? {}) as Record<string, unknown>;
  const read = (key: string): string => {
    const value = p[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${M5_ADMISSION_SITING_CONSUMER.consumerName}: payload has no ${key}`);
    }
    return value;
  };
  return { admissionId: read("admissionId"), patientId: read("patientId") };
}

/** End the creator's access grant on its own (the early-return paths where the siting/status work is skipped). */
async function endGrant(db: DbClient, organizationId: string, patientId: string): Promise<void> {
  await withOrgContext(db, { organizationId, userId: CONSUMER_USER_ID }, (scoped) =>
    endAdmittingAssignments(scoped as unknown as DbClient, { organizationId, patientId }),
  );
}

/**
 * M5's live `m6.admission.activated` binding — denormalizes the activating admission's provider
 * entity/location and applies M5's admission-driven patient lifecycle edge in the same transaction.
 * See the file header for the deliberate single-table scope and cross-module seam-not-import boundary.
 */
export function buildM5AdmissionSitingConsumer(deps: AdmissionSitingDeps) {
  return {
    consumerName: M5_ADMISSION_SITING_CONSUMER.consumerName,
    consumerModule: "m5" as const,
    eventTypes: [M5_ADMISSION_SITING_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;

      const admissionStatusReader = getSeam("AdmissionStatusReader");
      const siting = await admissionStatusReader.getAdmissionSiting(
        organizationId,
        facts.admissionId,
      );
      // No siting row (unknown/cross-tenant admission id) — nothing to denormalize. Not an error: the
      // admission may not yet be visible under this read's own RLS scope on a redelivery race, and a
      // later event for the same admission (or a later admission) will re-resolve correctly.
      if (!siting) {
        await endGrant(deps.db, organizationId, facts.patientId);
        return;
      }

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const [row] = await tx
            .select({ status: P.status })
            .from(P)
            .where(eq(P.id, facts.patientId))
            .limit(1);
          if (!row) {
            await endAdmittingAssignments(tx, { organizationId, patientId: facts.patientId });
            return;
          }
          // §2.4.1 `prospective --> active : admission approved (M6)` and `discharged --> active :
          // re-admission` — the status half of the activation, applied with the siting in one tx.
          const promote = activationPromotesToActive(row.status);
          const [patient] = await tx
            .select({ status: P.status })
            .from(P)
            .where(eq(P.id, facts.patientId))
            .limit(1)
            .for("update");
          if (!patient) {
            throw new Error(
              `${M5_ADMISSION_SITING_CONSUMER.consumerName}: patient '${facts.patientId}' not found`,
            );
          }

          const transition = transitionPatientOnAdmissionActivated(
            facts.patientId,
            patient.status as PatientStatus,
          );
          await tx
            .update(P)
            .set({
              providerEntityId: siting.providerEntityId,
              locationId: siting.locationId,
              ...(transition.kind === "activate"
                ? { status: "active", updatedAt: new Date() }
                : {}),
            })
            .where(eq(P.id, facts.patientId));

          // The creator's `admitting_staff` access grant ends with the activation (idempotent; no-op when absent).
          await endAdmittingAssignments(tx, { organizationId, patientId: facts.patientId });

          if (transition.kind === "activate") {
            await deps.outbox.publish(tx, {
              eventName: "m5.patient.status_changed",
              payload: {
                patientId: facts.patientId,
                organizationId,
                fromStatus: transition.fromStatus,
                toStatus: "active",
              },
              organizationId,
              aggregateKind: "patient",
              aggregateId: facts.patientId,
            });
          }
        },
      );
    },
  };
}

// apps/backend/src/modules/05-patient/outbox-consumers/m6-referral-closed.ts — ends the creator's
// `admitting_staff` access grant when the referral that created the patient is closed without an admission
// (declined, marked duplicate, withdrawn). Without it the grant stays open for a patient who will never be
// admitted; the admission-activated and admission-discharged consumers cover the other two terminal paths and
// `jobs/admitting-grant-expiry.ts` is the backstop.
//
// The payload may carry `patientCreatedByUserId` (the grant holder); the end is then scoped to that user.
// M5 does not depend on M6: the patient id arrives on the event payload (`patientId`, optional — a referral
// closed before any patient existed has none and the delivery is a no-op). Idempotent and org-explicit.
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { endAdmittingAssignments } from "../assignments-db";

export const M5_REFERRAL_CLOSED_CONSUMER = {
  consumerName: "m5.m6-referral-closed",
  eventTypes: ["m6.referral.declined", "m6.referral.duplicate", "m6.referral.withdrawn"],
} as const;

/** §3.3 — a consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

export interface ReferralClosedDeps {
  readonly db: DbClient;
}

export function buildM5ReferralClosedConsumer(deps: ReferralClosedDeps) {
  return {
    consumerName: M5_REFERRAL_CLOSED_CONSUMER.consumerName,
    consumerModule: "m5" as const,
    eventTypes: M5_REFERRAL_CLOSED_CONSUMER.eventTypes,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const payload = event.payload as {
        patientId?: unknown;
        patientCreatedByUserId?: unknown;
      } | null;
      const patientId = payload?.patientId;
      if (typeof patientId !== "string" || patientId.length === 0) return;
      // Only the patient creator's grant ends; events queued before the field existed end the patient-wide set.
      const creator = payload?.patientCreatedByUserId;
      const clinicianUserId =
        typeof creator === "string" && creator.length > 0 ? creator : undefined;
      const organizationId = event.organizationId;
      await withOrgContext(deps.db, { organizationId, userId: CONSUMER_USER_ID }, async (scoped) =>
        endAdmittingAssignments(scoped as unknown as DbClient, {
          organizationId,
          patientId,
          ...(clinicianUserId ? { clinicianUserId } : {}),
        }),
      );
    },
  };
}

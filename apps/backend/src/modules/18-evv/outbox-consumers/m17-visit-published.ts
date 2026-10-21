// M18's live M17 publication consumer. It owns a tenant-scoped visit snapshot used to seed the EVV
// capture window, removing the capture path's direct dependency on M17 persistence.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";

const REGISTRATION = schema.evvVisitRegistrations;

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("m18.register-published-visit: payload must be an object");
  }
  return value as Record<string, unknown>;
}

function stringOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m18.register-published-visit: '${key}' must be a non-empty string`);
  }
  return value;
}

function nullableStringOf(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`m18.register-published-visit: '${key}' must be a string or null`);
  }
  return value;
}

function instantOf(record: Record<string, unknown>, key: string): Date {
  const raw = stringOf(record, key);
  const value = new Date(raw);
  if (Number.isNaN(value.valueOf())) {
    throw new Error(`m18.register-published-visit: '${key}' must be an ISO instant`);
  }
  return value;
}

export const M18_VISIT_PUBLISHED_CONSUMER = {
  eventName: "m17.visit.published",
  consumerName: "m18.register-published-visit",
} as const;

export function buildM18VisitPublishedConsumer(deps: { readonly db: DbClient }) {
  return {
    consumerName: "m18.register-published-visit" as const,
    consumerModule: "m18" as const,
    eventTypes: ["m17.visit.published"] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }) {
      const payload = recordOf(event.payload);
      if (stringOf(payload, "organizationId") !== event.organizationId) {
        throw new Error("m18.register-published-visit: payload organization does not match tenant");
      }
      const providerEntityId = nullableStringOf(payload, "providerEntityId");
      const locationId = nullableStringOf(payload, "locationId");
      if (providerEntityId === null || locationId === null) {
        throw new Error(
          "m18.register-published-visit: published visit lacks required provider/location siting",
        );
      }
      const scheduledStartedAt = instantOf(payload, "scheduledStartedAt");
      const scheduledEndedAt = instantOf(payload, "scheduledEndedAt");
      if (scheduledEndedAt <= scheduledStartedAt) {
        throw new Error("m18.register-published-visit: visit window must have positive duration");
      }
      const values = {
        organizationId: event.organizationId,
        providerEntityId,
        locationId,
        visitId: stringOf(payload, "visitId"),
        patientId: stringOf(payload, "patientId"),
        admissionId: stringOf(payload, "admissionId"),
        assignedMembershipId: stringOf(payload, "assignedMembershipId"),
        assignedDiscipline: stringOf(payload, "assignedDiscipline"),
        serviceTypeCode: stringOf(payload, "visitPurpose"),
        patientAddressId: nullableStringOf(payload, "patientAddressId"),
        externalFacilityId: nullableStringOf(payload, "externalFacilityId"),
        scheduledStartedAt,
        scheduledEndedAt,
        sourceOutboxEventId: event.id,
      };
      await withOrgContext(
        deps.db,
        { organizationId: event.organizationId, userId: "" },
        async (rawTx) => {
          const tx = rawTx as DbClient;
          await tx
            .insert(REGISTRATION)
            .values(values)
            .onConflictDoUpdate({
              target: [REGISTRATION.organizationId, REGISTRATION.visitId],
              set: {
                providerEntityId: values.providerEntityId,
                locationId: values.locationId,
                patientId: values.patientId,
                admissionId: values.admissionId,
                assignedMembershipId: values.assignedMembershipId,
                assignedDiscipline: values.assignedDiscipline,
                serviceTypeCode: values.serviceTypeCode,
                patientAddressId: values.patientAddressId,
                externalFacilityId: values.externalFacilityId,
                scheduledStartedAt: values.scheduledStartedAt,
                scheduledEndedAt: values.scheduledEndedAt,
                sourceOutboxEventId: values.sourceOutboxEventId,
                updatedAt: new Date(),
              },
            });
        },
      );
    },
  };
}

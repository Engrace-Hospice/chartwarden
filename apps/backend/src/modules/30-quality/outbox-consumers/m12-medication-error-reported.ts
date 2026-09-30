// apps/backend/src/modules/30-quality/outbox-consumers/m12-medication-error-reported.ts — F-205 (#248).
//
// The `OutboxConsumerBinding` for M30's previously-declared-but-unbound `m12.medication.error_reported`
// topic — calls the real, already-built `handleMedicationErrorReported`
// (`packages/quality/src/consumers/handlers.ts`), which reuses `buildIncidentDraftFromEvent` and persists
// a `medication_error` `incident_report` draft via `ports.createIncidentDraft` (real since F-185, #248, see
// `./upstream-consumer-ports.ts`). Mirrors `./m37-restraint-applied.ts` exactly, the SAME shape for the SAME
// reason — this was the only missing piece: the pure handler and `createIncidentDraft` both already existed,
// unwired (F-115/F-165/F-174, #248).
//
// PRODUCER: F-165/F-174 (#248) found this event had NO producer anywhere in `12-dosespot/`/`13-emar/`. The
// user has since decided the trigger — a new explicit clinician-initiated report action, NOT auto-derived —
// built alongside this binding as `POST /api/v1/medication-orders/:id/report-error`
// (`../../12-dosespot/dosespot-route-service-db.ts`'s `reportMedicationError`).
//
// REPORTER IDENTITY: unlike `m37-restraint-applied.ts`'s `M30_SYSTEM_MEMBERSHIP_ID` sentinel (M37 has no
// per-event reporter fact), the catalogued `m12.medication.error_reported` payload (`events-by-m12.ts`)
// already carries a REAL `reportedByMembershipId` — the actual clinician who filed the report — so
// `incident_report.reported_by_membership_id` is populated honestly from the wire payload (the F-165
// correction: crediting the real reporter is MORE correct than any system-actor convention would be).
//
// PROVIDER-ENTITY RESOLUTION: the payload carries no `providerEntityId`/`locationId` (`medication_order`'s
// own columns are nullable and never written — see `medicationOrderScheduleContextForOrg`'s own doc comment,
// `12-dosespot/seams/drizzle-store.ts`). Resolved via the SAME two-step chain M13's §2.3 D2 scheduled-dose
// materializer already uses (F-166, #248): M12's `medicationOrderScheduleContextForOrg` (orderId →
// admissionId) then M6's `admissionSchedulingContextForOrg` (admissionId → providerEntityId/locationId).
// M30's manifest `dependsOn` is `[1, 2, 3, 4, 10, 23, 27, 36, 38]` — it does NOT include 6 or 12 — so both
// seams are injected as PORTS (the F-160 `CapConsumerStore` shape), resolved at the composition root exactly
// as `buildM13MaterializeScheduleConsumer`'s `orderContext`/`resolveAdmission` closures already are.
//
// An order or admission this org does not recognise (cross-tenant / stale redelivery), or an admission with
// no resolved `providerEntityId` (never activated / unsited), is a NO-OP, not a dead-letter — the same
// posture `m30-m18-evv-visit-verified.ts`/`m30-m37-restraint-applied.ts` already establish for this class of
// gap; a medication-error report against an order this org cannot site is advisory-adjacent, not
// integrity-critical.
import type { DbClient } from "@wardenx/db";
import { handleMedicationErrorReported, type IncidentTriggerEvent } from "@wardenx/quality";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import { buildM30UpstreamConsumerPorts } from "./upstream-consumer-ports";

/** M12's org-explicit `medicationOrderScheduleContextForOrg` seam, injected as a port — see the file
 *  header for why this cannot be a direct import. Only the `admissionId` this consumer needs is typed. */
export type MedicationOrderScheduleContextForOrg = (
  db: DbClient,
  organizationId: string,
  orderId: string,
) => Promise<{ readonly admissionId: string } | null>;

/** M6's org-explicit `admissionSchedulingContextForOrg` seam, injected as a port — see the file header. */
export type AdmissionSchedulingContextForOrg = (
  db: DbClient,
  organizationId: string,
  admissionId: string,
) => Promise<{
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
} | null>;

function objectOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`m30.m12-medication-error-reported: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m30.m12-medication-error-reported: '${key}' must be a non-empty string`);
  }
  return value;
}

function optionalStringOf(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `m30.m12-medication-error-reported: '${key}' must be a non-empty string when present`,
    );
  }
  return value;
}

export function buildM30MedicationErrorReportedConsumer(deps: {
  readonly db: DbClient;
  /** M12's seam, injected as a port — M30's manifest `dependsOn` excludes 12 (see the file header). */
  readonly medicationOrderScheduleContextForOrg: MedicationOrderScheduleContextForOrg;
  /** M6's seam, injected as a port — M30's manifest `dependsOn` excludes 6 (see the file header). */
  readonly admissionSchedulingContextForOrg: AdmissionSchedulingContextForOrg;
}): OutboxConsumerBinding {
  const ports = buildM30UpstreamConsumerPorts(deps.db);
  return {
    consumerName: "m30.m12-medication-error-reported",
    consumerModule: "m30",
    eventTypes: ["m12.medication.error_reported"],
    async handle(event) {
      const payload = objectOf(event.payload, "event payload");
      const orderId = stringOf(payload, "orderId");
      const patientId = stringOf(payload, "patientId");
      const medicationErrorId = stringOf(payload, "medicationErrorId");
      const reportedByMembershipId = stringOf(payload, "reportedByMembershipId");
      const reportedAt = stringOf(payload, "reportedAt");
      const summary = optionalStringOf(payload, "summary");

      const orderContext = await deps.medicationOrderScheduleContextForOrg(
        deps.db,
        event.organizationId,
        orderId,
      );
      if (orderContext === null) return; // no order this org recognises — see file header.

      const siting = await deps.admissionSchedulingContextForOrg(
        deps.db,
        event.organizationId,
        orderContext.admissionId,
      );
      if (siting === null || siting.providerEntityId === null) return; // unsited admission — see file header.

      const trigger: Extract<IncidentTriggerEvent, { type: "m12.medication.error_reported" }> = {
        type: "m12.medication.error_reported",
        organizationId: event.organizationId,
        providerEntityId: siting.providerEntityId,
        patientId,
        ...(siting.locationId !== null ? { locationId: siting.locationId } : {}),
        occurredAt: new Date(reportedAt),
        triggeringEventOutboxId: event.id,
        reportedByMembershipId,
        medicationOrderId: orderId,
        medicationErrorId,
        ...(summary !== undefined ? { summary } : {}),
      };
      await handleMedicationErrorReported(trigger, ports);
    },
  };
}

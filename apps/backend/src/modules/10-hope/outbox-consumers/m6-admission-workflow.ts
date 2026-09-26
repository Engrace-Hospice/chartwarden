// M10's live M6 admission/discharge consumer. M6 owns admission state; M10 owns the HOPE workflow
// ledger materialized from those facts.
import { type DbClient, schema } from "@wardenx/db";
import {
  DEFAULT_ORG_TIME_ZONE,
  planAdmissionTimepoints,
  planDischargeTimepoint,
} from "@wardenx/hope";
import { withOrgContext } from "@wardenx/tenancy";
import type { AdmissionStatusReader, LocalDate } from "@wardenx/types";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { anchorDateOf } from "../scheduling/schedule-writer";

const SCHED = schema.hopeTimepointSchedules;

export interface M10AdmissionWorkflowOutboxPort {
  publish(
    tx: DbClient,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

export const M10_M6_ADMISSION_WORKFLOW_CONSUMER = {
  consumerName: "m10.m6-admission-workflow",
  eventTypes: ["m6.admission.activated", "m6.admission.discharged"],
} as const;

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("m10.m6-admission-workflow: payload must be an object");
  }
  return value as Record<string, unknown>;
}

function stringOf(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m10.m6-admission-workflow: '${key}' must be a non-empty string`);
  }
  return value;
}

export function buildM10AdmissionWorkflowConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: M10AdmissionWorkflowOutboxPort;
  readonly admissions: AdmissionStatusReader;
}): {
  readonly consumerName: "m10.m6-admission-workflow";
  readonly consumerModule: "m10";
  readonly eventTypes: readonly ["m6.admission.activated", "m6.admission.discharged"];
  handle(event: {
    readonly id: string;
    readonly organizationId: string;
    readonly eventType: string;
    readonly payload: unknown;
  }): Promise<void>;
} {
  return {
    consumerName: M10_M6_ADMISSION_WORKFLOW_CONSUMER.consumerName,
    consumerModule: "m10",
    eventTypes: M10_M6_ADMISSION_WORKFLOW_CONSUMER.eventTypes,
    async handle(event) {
      const payload = recordOf(event.payload);
      const admissionId = stringOf(payload, "admissionId");
      const summary = await deps.admissions.getAdmissionSummary(event.organizationId, admissionId);
      if (summary.organizationId !== event.organizationId) {
        throw new Error("m10.m6-admission-workflow: admission summary tenant mismatch");
      }
      const locationId = summary.locationId ?? null;
      if (!summary.providerEntityId || !locationId) {
        throw new Error(
          `m10.m6-admission-workflow: admission '${admissionId}' has no provider/location siting`,
        );
      }

      await withOrgContext(
        deps.db,
        { organizationId: event.organizationId, userId: "" },
        async (tx) => {
          const t = tx as DbClient;
          const timeZone = summary.locationTimeZone ?? DEFAULT_ORG_TIME_ZONE;
          const descriptors =
            event.eventType === "m6.admission.activated"
              ? planAdmissionTimepoints({
                  // The ORG-LOCAL day of the activation INSTANT, not its UTC date: an activation at
                  // 23:30 in America/Los_Angeles is 06:30Z the next day, and anchoring on that UTC date
                  // opened the Admission window the day AFTER the patient was admitted. The event's
                  // `activatedAt` (schema-required) is the instant; M6's summary only carries its UTC
                  // `yyyy-mm-dd`, so it is the fallback, not the source.
                  anchorDate: anchorDateOf(
                    typeof payload.activatedAt === "string" && payload.activatedAt.length > 10
                      ? payload.activatedAt
                      : (summary.activatedAt ?? stringOf(payload, "activatedAt")),
                    timeZone,
                    "activatedAt",
                  ),
                  timeZone,
                })
              : [
                  planDischargeTimepoint({
                    // Validate the M6 discharge discriminator is present; Section-Q branching remains a
                    // recording-boundary rule on the HOPE assessment itself.
                    dischargeDate: anchorDateOf(
                      stringOf(payload, "dischargeDate"),
                      timeZone,
                      "dischargeDate",
                    ),
                    timeZone,
                  }),
                ];
          if (event.eventType === "m6.admission.discharged") {
            stringOf(payload, "reason");
            const dischargeDate = anchorDateOf(
              stringOf(payload, "dischargeDate"),
              timeZone,
              "dischargeDate",
            );
            await t
              .update(SCHED)
              .set({
                status: "skipped",
                skipReasonCode: "discharged_before_huv_window",
                updatedAt: new Date(),
              })
              .where(
                and(
                  inArray(SCHED.rfaKind, ["02_huv1", "03_huv2"]),
                  gt(SCHED.windowOpensAt, new Date(`${dischargeDate}T23:59:59.999Z`)),
                  eq(SCHED.admissionId, admissionId),
                  eq(SCHED.status, "open"),
                  isNull(SCHED.completedByAssessmentId),
                ),
              );
          }

          for (const descriptor of descriptors) {
            const [inserted] = await t
              .insert(SCHED)
              .values({
                organizationId: event.organizationId,
                providerEntityId: summary.providerEntityId,
                locationId,
                patientId: summary.patientId,
                admissionId,
                rfaKind: descriptor.rfaKind,
                windowOpensAt: new Date(descriptor.window.windowOpensAt),
                windowClosesAt: new Date(descriptor.window.windowClosesAt),
                lateDeadlineAt: new Date(descriptor.window.lateDeadlineAt),
                alertCadence: descriptor.alertCadence,
                generatedBy: descriptor.generatedBy,
              })
              .onConflictDoNothing()
              .returning({ id: SCHED.id });
            if (!inserted) continue;
            await deps.outbox.publish(t, {
              eventName: "m10.hope.timepoint_scheduled",
              organizationId: event.organizationId,
              aggregateKind: "hope_timepoint_schedule",
              aggregateId: inserted.id,
              payload: {
                scheduleId: inserted.id,
                rfaKind: descriptor.rfaKind,
                windowOpensAt: descriptor.window.windowOpensAt,
                windowClosesAt: descriptor.window.windowClosesAt,
                lateDeadlineAt: descriptor.window.lateDeadlineAt,
              },
            });
          }
        },
      );
    },
  };
}

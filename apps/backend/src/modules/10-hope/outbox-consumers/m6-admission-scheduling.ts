// apps/backend/src/modules/10-hope/outbox-consumers/m6-admission-scheduling.ts — #48, the LIVE
// `m6.admission.activated` / `m6.admission.discharged` → HOPE timepoint-schedule consumer.
//
// This is the trigger the pure planners were written for: "facts the scheduling worker injects from M6's
// `admission.activated` outbox event (D9 precedent: the consumer carries the dep; M10 never imports M6
// schema)". Both consumed event names are STRING literals and every admission fact is read through M6's
// published `AdmissionStatusReader` seam, so this adds no `dependsOn` edge to M10's manifest.
// The write itself lives in ../scheduling/schedule-writer.ts, shared with the §4.1 route-20 regenerate.
//
// WHY NOT A BULLMQ QUEUE — §4.8 declares `schedule-hope-timepoints` / `materialize-discharge-timepoint`
// as event-driven jobs with retry/backoff params. The outbox dispatcher already provides exactly those
// semantics (claim, attempt count, exponential backoff, a `failed` DLQ terminal, and a durable
// `(event_id, consumer_name)` receipt), so the work runs in the consumer — the M5 death-cascade
// precedent. Putting a second durable queue in front of an already-durable relay would add a failure
// mode, not remove one. The §4.8 param entries stay as declared tuning for a future queue if per-org
// throughput ever needs one.
import type { DbClient } from "@wardenx/db";
import {
  type TimepointScheduleDescriptor,
  planAdmissionTimepoints,
  planDischargeTimepoint,
} from "@wardenx/hope";
import type { HopeWriteOutboxPort } from "../hope-route-service-db";
import {
  type AdmissionSitingResolver,
  HOPE_SCHEDULE_TIME_ZONE,
  anchorDateOf,
  schedulingSitingFor,
  writeSchedules,
} from "../scheduling/schedule-writer";

export const M10_ADMISSION_ACTIVATED_EVENT = "m6.admission.activated";
export const M10_ADMISSION_DISCHARGED_EVENT = "m6.admission.discharged";
export const M10_SCHEDULING_CONSUMER_NAME = "m10.admission-timepoint-scheduling";

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${M10_SCHEDULING_CONSUMER_NAME}: payload must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${M10_SCHEDULING_CONSUMER_NAME}: '${key}' must be a non-empty string`);
  }
  return value;
}

/**
 * Build the LIVE scheduling consumer (registered in the boot dispatcher's `consumers` array,
 * apps/backend/src/index.ts).
 *
 * Activation materializes the three admission-anchored windows (Admission days 1–5, HUV1 days 6–15,
 * HUV2 days 16–30). Discharge materializes the single 7-day Discharge RFA window — D9 keeps it out of
 * the admission plan because its `discharge_reason` branch cannot be known until discharge happens.
 *
 * The anchor comes from the EVENT, not the admission row, so a redelivery replays the fact as it was
 * announced; the writer is idempotent per (admission, rfa_kind) regardless.
 */
export function buildM10AdmissionSchedulingConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: HopeWriteOutboxPort;
  /** Org IANA timezone for the D2 calendar-day → instant boundary math; injectable so the day a
   * tenant-timezone source lands, one call site changes. */
  readonly timeZone?: string;
  /**
   * How this consumer learns about the admission. The composition root MUST bind M6's org-explicit
   * `admissionSchedulingContextForOrg` here: the default is the §4.7 seam, whose id-keyed reads open
   * `withOrgContextFromRequest`, and a relay tick has no ambient request scope — every delivery would
   * dead-letter with `no ambient request context`. Left injectable (rather than required) so the unit
   * tests can drive the same consumer through a seam double.
   */
  readonly resolveSiting?: AdmissionSitingResolver;
}) {
  const timeZone = deps.timeZone ?? HOPE_SCHEDULE_TIME_ZONE;
  return {
    consumerName: M10_SCHEDULING_CONSUMER_NAME,
    consumerModule: "m10" as const,
    eventTypes: [M10_ADMISSION_ACTIVATED_EVENT, M10_ADMISSION_DISCHARGED_EVENT] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly eventType: string;
      readonly payload: unknown;
    }): Promise<void> {
      const payload = recordOf(event.payload);
      const admissionId = stringOf(payload, "admissionId");
      const siting = await schedulingSitingFor(
        event.organizationId,
        admissionId,
        deps.resolveSiting,
      );

      const descriptors: readonly TimepointScheduleDescriptor[] =
        event.eventType === M10_ADMISSION_ACTIVATED_EVENT
          ? planAdmissionTimepoints({
              anchorDate: anchorDateOf(stringOf(payload, "activatedAt"), timeZone, "activatedAt"),
              timeZone,
            })
          : [
              planDischargeTimepoint({
                dischargeDate: anchorDateOf(
                  stringOf(payload, "dischargeDate"),
                  timeZone,
                  "dischargeDate",
                ),
                timeZone,
              }),
            ];

      await writeSchedules(deps.db, deps.outbox, {
        organizationId: event.organizationId,
        admissionId,
        siting,
        descriptors,
      });
    },
  };
}

// apps/backend/src/modules/14-idg/consumers/m9-since-last-idg.ts — the §4.5 "since last IDG" projection
// cache, M9 half (F-164, #248). See `./since-last-idg-cache.ts` for the scope decision and key scheme.
//
// Both events' DECLARED `payloadSchema` (`apps/backend/src/modules/09-assessments/events-by-m9.ts`) is
// narrower than what the real emit sites actually publish: `m9.assessment.recorded`'s schema already
// carries `patientId`, but `m9.assessment.significant_change`'s schema does not, even though the real
// emit site (`assessments-route-service-db.ts`, the significant-change detector) sends `patientId` AND
// `detectedAt` on every delivery — confirmed by reading the emit call directly, not assumed from the
// schema. TypeBox's `Type.Object` accepts unlisted extra properties by default, so the boot-time
// `Value.Check` does not reject them; this file reads both fields off the raw payload rather than through
// a narrower type, matching `11-orders/outbox-consumers/m9-assessment-significant-change.ts`'s own
// existing live binding for this SAME event, which already depends on `payload.patientId` being present.
// This payload/schema gap is reported to the coordinator, not fixed here (`events-by-m9.ts` is not this
// pass's file to edit).
import type Redis from "ioredis";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import { appendSinceLastIdgEntry } from "./since-last-idg-cache";

export interface SinceLastIdgRedisDeps {
  readonly redis: Redis;
}

function stringField(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function boolField(payload: unknown, key: string): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  return (payload as Record<string, unknown>)[key] === true;
}

/**
 * `m9.assessment.recorded` → the shared `significantAssessmentChanges` slot, `changeKind: "recorded"` /
 * `"corrected"`. Every assessment capture, not only a clinically-significant one — see `./since-last-idg
 * -cache.ts`'s header for why this shares the one typed slot the packet builder declares rather than a
 * new untyped one.
 */
export function buildM14AssessmentRecordedConsumer(
  deps: SinceLastIdgRedisDeps,
): OutboxConsumerBinding {
  return {
    consumerName: "m14.m9-assessment-recorded",
    consumerModule: "m14",
    eventTypes: ["m9.assessment.recorded"],
    async handle(event): Promise<void> {
      const patientId = stringField(event.payload, "patientId");
      const assessmentId = stringField(event.payload, "assessmentId");
      const scaleType = stringField(event.payload, "scaleType");
      const capturedAt = stringField(event.payload, "capturedAt");
      if (
        patientId === null ||
        assessmentId === null ||
        scaleType === null ||
        capturedAt === null
      ) {
        throw new Error("m14.m9-assessment-recorded: payload missing a required field");
      }
      await appendSinceLastIdgEntry(
        deps.redis,
        patientId,
        "significantAssessmentChanges",
        event.id,
        {
          _digestId: event.id,
          assessmentId,
          scaleKind: scaleType,
          changeKind: boolField(event.payload, "isCorrection") ? "corrected" : "recorded",
          occurredAt: capturedAt,
        },
      );
    },
  };
}

/**
 * `m9.assessment.significant_change` → the same slot, `changeKind` carrying the rule that fired
 * (`ruleId`). `patientId`/`detectedAt` are read off the raw payload — see the file header.
 */
export function buildM14AssessmentSignificantChangeConsumer(
  deps: SinceLastIdgRedisDeps,
): OutboxConsumerBinding {
  return {
    consumerName: "m14.m9-significant-change",
    consumerModule: "m14",
    eventTypes: ["m9.assessment.significant_change"],
    async handle(event): Promise<void> {
      const patientId = stringField(event.payload, "patientId");
      const assessmentId = stringField(event.payload, "assessmentId");
      const scaleType = stringField(event.payload, "scaleType");
      const ruleId = stringField(event.payload, "ruleId");
      const detectedAt = stringField(event.payload, "detectedAt");
      if (
        patientId === null ||
        assessmentId === null ||
        scaleType === null ||
        ruleId === null ||
        detectedAt === null
      ) {
        throw new Error("m14.m9-significant-change: payload missing a required field");
      }
      await appendSinceLastIdgEntry(
        deps.redis,
        patientId,
        "significantAssessmentChanges",
        event.id,
        {
          _digestId: event.id,
          assessmentId,
          scaleKind: scaleType,
          changeKind: ruleId,
          occurredAt: detectedAt,
        },
      );
    },
  };
}

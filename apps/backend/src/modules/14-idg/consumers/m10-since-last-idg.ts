// apps/backend/src/modules/14-idg/consumers/m10-since-last-idg.ts — the §4.5 "since last IDG" projection
// cache, M10 half (F-164, #248). See `./since-last-idg-cache.ts` for the scope decision and key scheme.
//
// Neither event's payload carries `patientId` — checked against BOTH the declared `payloadSchema`
// (`apps/backend/src/modules/10-hope/events-by-m10.ts`) and the real emit sites
// (`10-hope/hope-route-service-db.ts`'s `j2051_trigger_fired` / `sfv_created` emissions), which is a
// sharper gap than M9's (F-030/undeclared-but-present): here the field is genuinely absent from the wire,
// not merely undeclared. Both events DO carry a `hope_assessment.id` (`assessmentId` on
// `j2051_trigger_fired`, `triggeringAssessmentId` on `sfv_created`), and `hope_assessment.patient_id` is a
// real NOT NULL column — so `patientId` is resolved via M10's org-explicit `hopeAssessmentPatientIdForOrg`
// seam (`10-hope/seams/drizzle-store.ts`), injected as a port rather than read off M10's schema directly
// (M14's `dependsOn` is `[1, 7, 8, 36]` — no edge to 10; `arch:tables` refuses a direct cross-module
// Drizzle import regardless of `dependsOn`). `HopeJ2051Provider`/`HopeTimepointProvider` are deliberately
// NOT used for this: they are per-patient-keyed reads (patientId IN, not OUT) and would not answer this
// question even if their store were request-scope-free, which it is not — M10's own seam store opens every
// read under the caller's request scope, the same "a relay tick is not a request" wall
// `11-orders/outbox-consumers/m9-assessment-significant-change.ts` already documents for the identical M11
// seam shape.
import type Redis from "ioredis";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import { appendSinceLastIdgEntry } from "./since-last-idg-cache";

export interface SinceLastIdgHopeDeps {
  readonly redis: Redis;
  /** M10's org-explicit `hopeAssessmentPatientIdForOrg` seam, injected as a port. */
  readonly patientIdForHopeAssessment: (
    organizationId: string,
    hopeAssessmentId: string,
  ) => Promise<string | null>;
}

function stringField(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * `m10.hope.j2051_trigger_fired` → the shared `j2051Triggers` slot. `triggerKind` folds `maxSeverity`
 * into the label — `PacketHopeTriggerDigest` has no separate severity field, and the payload's own
 * `maxSeverity` (`none`/`mild`/`moderate`/`severe` per the J2051 evaluator) is otherwise lost.
 */
export function buildM14HopeJ2051TriggerConsumer(deps: SinceLastIdgHopeDeps): OutboxConsumerBinding {
  return {
    consumerName: "m14.m10-j2051-trigger",
    consumerModule: "m14",
    eventTypes: ["m10.hope.j2051_trigger_fired"],
    async handle(event): Promise<void> {
      const assessmentId = stringField(event.payload, "assessmentId");
      const maxSeverity = stringField(event.payload, "maxSeverity");
      const triggeredAt = stringField(event.payload, "triggeredAt");
      if (assessmentId === null || maxSeverity === null || triggeredAt === null) {
        throw new Error("m14.m10-j2051-trigger: payload missing a required field");
      }
      const patientId = await deps.patientIdForHopeAssessment(event.organizationId, assessmentId);
      if (patientId === null) return; // no matching hope_assessment in this org — nothing to cache
      await appendSinceLastIdgEntry(deps.redis, patientId, "j2051Triggers", event.id, {
        _digestId: event.id,
        hopeAssessmentId: assessmentId,
        triggerKind: `j2051_${maxSeverity}`,
        firedAt: triggeredAt,
      });
    },
  };
}

/**
 * `m10.hope.sfv_created` → the SAME `j2051Triggers` slot (the §4.5 table's own "Same projection cache"
 * note for this row), `triggerKind: "sfv_created"`, `firedAt` from the obligation's `dueAt` (the payload
 * carries no creation timestamp of its own).
 */
export function buildM14HopeSfvCreatedConsumer(deps: SinceLastIdgHopeDeps): OutboxConsumerBinding {
  return {
    consumerName: "m14.m10-sfv-created",
    consumerModule: "m14",
    eventTypes: ["m10.hope.sfv_created"],
    async handle(event): Promise<void> {
      const triggeringAssessmentId = stringField(event.payload, "triggeringAssessmentId");
      const sfvId = stringField(event.payload, "sfvId");
      const dueAt = stringField(event.payload, "dueAt");
      if (triggeringAssessmentId === null || sfvId === null || dueAt === null) {
        throw new Error("m14.m10-sfv-created: payload missing a required field");
      }
      const patientId = await deps.patientIdForHopeAssessment(
        event.organizationId,
        triggeringAssessmentId,
      );
      if (patientId === null) return; // no matching hope_assessment in this org — nothing to cache
      await appendSinceLastIdgEntry(deps.redis, patientId, "j2051Triggers", event.id, {
        _digestId: event.id,
        hopeAssessmentId: triggeringAssessmentId,
        triggerKind: "sfv_created",
        firedAt: dueAt,
      });
    },
  };
}

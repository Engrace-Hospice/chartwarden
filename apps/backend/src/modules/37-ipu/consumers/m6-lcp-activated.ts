// apps/backend/src/modules/37-ipu/consumers/m6-lcp-activated.ts — the M6 -> M37 half of the IPU
// level-of-care handshake (M37 spec §2.2 row `bed_assigned -> active`, §4.5; M6 §2.3.5).
//
// `POST /ipu-admissions/:id/confirm` is system-internal (GAP-106): no tenant session may drive it, and the
// service demands the typed `m6LcpAckActor`. Until this consumer nothing minted that actor, so an IPU
// admission could never leave `bed_assigned`. M6 now publishes `m6.level_of_care.activated` from the same
// transaction that flips the period `assigning` -> `active` (`confirmLocBedAssignment`); this consumer is the
// acknowledgement.
//
// ORG-EXPLICIT: an outbox relay tick is not a request. The organization comes from the event envelope, the
// lookup runs under `withOrgContext` for that org, and `service.confirm` opens its own `withOrgContext` from
// the actor's organization. Nothing here reads an ambient request context.
//
// FAIL CLOSED: the actor is minted from the event's org and period id only. The admission is found by the
// period id (unique per org), cross-checked against the M6 admission id the event names, and `confirm`
// itself re-verifies `ackedLevelOfCarePeriodId === ipu_admission.level_of_care_period_id`
// (`IPU_LCP_ACK_MISMATCH`). An unknown period, a disagreeing admission, or any `confirm` refusal (illegal
// transition, `GIP_CRITERIA_REQUIRED`) throws so the delivery dead-letters for a human instead of being
// swallowed.
//
// IDEMPOTENT: a redelivery that finds the admission already past `bed_assigned` returns without acting. A
// concurrent delivery that loses the race makes `confirm` throw an illegal transition; the consumer re-reads
// and treats "now activated" as success, and rethrows anything else.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";
import type { IpuRouteService } from "../routes/service";
import { m6LcpAckActor } from "../routes/system-actor";

const A = schema.ipuAdmission;

/** The `withOrgContext` session-GUC actor for a consumer-driven read (F-102's empty-string convention). */
const CONSUMER_USER_ID = "";

/** States a confirmed admission has reached or passed: a redelivery must not act on any of them. */
const ALREADY_CONFIRMED_STATES: ReadonlySet<string> = new Set([
  "active",
  "transferring",
  "transferred",
  "discharged",
  "deceased",
  "closed",
]);

export const M37_LCP_ACTIVATED_CONSUMER = {
  eventName: "m6.level_of_care.activated",
  consumerName: "m37.lcp-activated",
} as const;

/** The admission facts the consumer needs, found by the acknowledged M6 level-of-care period. */
export interface LcpAdmissionFacts {
  readonly id: string;
  readonly state: string;
  readonly admissionId: string;
}

export interface LcpAdmissionLookup {
  findByLevelOfCarePeriod(
    organizationId: string,
    levelOfCarePeriodId: string,
  ): Promise<LcpAdmissionFacts | null>;
}

export interface LcpActivatedConsumerDeps {
  readonly service: Pick<IpuRouteService, "confirm">;
  readonly lookup: LcpAdmissionLookup;
}

/** The production lookup: one RLS-scoped read as the NOBYPASSRLS app role, explicit about the org. */
export function buildDrizzleLcpAdmissionLookup(db: DbClient): LcpAdmissionLookup {
  return {
    async findByLevelOfCarePeriod(organizationId, levelOfCarePeriodId) {
      return withOrgContext(db, { organizationId, userId: CONSUMER_USER_ID }, async (scoped) => {
        const tx = scoped as unknown as DbClient;
        const [row] = await tx
          .select({ id: A.id, state: A.state, admissionId: A.admissionId })
          .from(A)
          .where(
            and(
              eq(A.organizationId, organizationId),
              eq(A.levelOfCarePeriodId, levelOfCarePeriodId),
            ),
          )
          .limit(1);
        return row ?? null;
      });
    },
  };
}

function nonEmpty(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${M37_LCP_ACTIVATED_CONSUMER.consumerName}: '${key}' must be a non-empty string`,
    );
  }
  return value;
}

/**
 * M37's live `m6.level_of_care.activated` binding. Confirms the `bed_assigned` admission that M6 just
 * acknowledged, as the typed `m6LcpAckActor` (never from a role string, header or body).
 */
export function buildM37LcpActivatedConsumer(deps: LcpActivatedConsumerDeps) {
  return {
    consumerName: M37_LCP_ACTIVATED_CONSUMER.consumerName,
    consumerModule: "m37" as const,
    eventTypes: [M37_LCP_ACTIVATED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const name = M37_LCP_ACTIVATED_CONSUMER.consumerName;
      if (typeof event.organizationId !== "string" || event.organizationId.length === 0) {
        throw new Error(`${name}: the event carries no organization`);
      }
      const record = (event.payload ?? {}) as Record<string, unknown>;
      const levelOfCarePeriodId = nonEmpty(record, "levelOfCarePeriodId");
      const admissionId = nonEmpty(record, "admissionId");
      const organizationId = event.organizationId;

      const admission = await deps.lookup.findByLevelOfCarePeriod(
        organizationId,
        levelOfCarePeriodId,
      );
      if (!admission) {
        throw new Error(
          `${name}: no ipu_admission carries level-of-care period ${levelOfCarePeriodId}`,
        );
      }
      if (admission.admissionId !== admissionId) {
        throw new Error(
          `${name}: ipu_admission ${admission.id} belongs to a different M6 admission than the event's`,
        );
      }
      if (ALREADY_CONFIRMED_STATES.has(admission.state)) return;

      try {
        await deps.service.confirm(
          m6LcpAckActor(organizationId, levelOfCarePeriodId),
          admission.id,
        );
      } catch (error) {
        const after = await deps.lookup.findByLevelOfCarePeriod(
          organizationId,
          levelOfCarePeriodId,
        );
        if (after && ALREADY_CONFIRMED_STATES.has(after.state)) return;
        throw error;
      }
    },
  };
}

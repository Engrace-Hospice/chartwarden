// apps/backend/src/modules/11-orders/outbox-consumers/m9-assessment-significant-change.ts — the §2.7 D7
// M9 significant-change order-suggestion banner consumer (F-15x, #248).
//
// `decideAssessmentSuggestion` (../consumers/assessment-trigger.ts) is M11's complete, pure, unit-tested
// §2.7 decider since M11-T07, and `consumers/suggestion-banner.ts`'s own header names exactly where it
// lands: "the live consumer projects suggestions into Valkey under `orders:suggestion:<patientId>` (TTL
// 7 days) and emits `m11.order.suggestion_state_changed`". Nothing ever built that live consumer — no
// `OutboxConsumerBinding` existed for `m9.assessment.significant_change`, no Valkey read or write of that
// key exists anywhere in the repository, and `m11.order.suggestion_state_changed` (catalogued, D7) has
// never been emitted. A qualifying ESAS-r / PAINAD threshold crossing on an M9 assessment has never once
// raised a comfort-medication or lab order-suggestion banner in any deployment.
//
// STATE MODEL (D7 — derived, no `order_suggestion` table): the Valkey value at `orders:suggestion:<pid>`
// is a JSON array of `OrderSuggestionEntry`, refreshed with a 7-day TTL on every write. There is no read
// route yet either (out of this pass's scope — this binds the WRITE half the decider already resolves to;
// exposing the banner to the chart UI is a separate, unbuilt M11 route). `alreadySuggested` is read
// straight off that array; `orderAlreadyCreated` is a direct `order_record` query scoped with
// `withOrgContext` (M11's own `ordersForTriggeringAssessment` seam opens `withOrgContextFromRequest`,
// which throws outside a request scope — a relay tick is not a request, the `../consumers/death-discharge
// .ts` / F-105 lesson one module over — so this reads the table directly rather than through that seam).
//
// The event name is a STRING literal only (no M9 schema import): M11 reads M9 solely through the
// foundation outbox, never via a `dependsOn` edge (§4 boundary rule) — `SignificantChangePayload` is
// `assessment-trigger.ts`'s own leaf-typed projection of the wire payload.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, or } from "drizzle-orm";
import type Redis from "ioredis";
import {
  type SignificantChangePayload,
  decideAssessmentSuggestion,
} from "../consumers/assessment-trigger";
import type { OrderSuggestionEntry } from "../consumers/suggestion-banner";
import type { OrderWriteOutboxPort } from "../orders-route-service-db";

const ORDER = schema.orderRecords;

/** §3.3 — a consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

const BANNER_KEY_PREFIX = "wardenx:m11:orders:suggestion";
const BANNER_TTL_SEC = 7 * 24 * 60 * 60; // 7 days, per suggestion-banner.ts's own documented TTL

export const M11_ASSESSMENT_SUGGESTION_CONSUMER = {
  eventName: "m9.assessment.significant_change",
  consumerName: "m11.m9-assessment-significant-change",
} as const;

export interface AssessmentSuggestionDeps {
  readonly db: DbClient;
  readonly redis: Redis;
  /** The bound publisher — `Value.Check`s `m11.*` against the boot catalog. */
  readonly outbox: OrderWriteOutboxPort;
}

function bannerKey(patientId: string): string {
  return `${BANNER_KEY_PREFIX}:${patientId}`;
}

async function readBanner(redis: Redis, patientId: string): Promise<OrderSuggestionEntry[]> {
  const raw = await redis.get(bannerKey(patientId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OrderSuggestionEntry[]) : [];
  } catch {
    return [];
  }
}

function factsOf(payload: unknown): SignificantChangePayload {
  const p = (payload ?? {}) as Record<string, unknown>;
  const read = (key: string): string => {
    const value = p[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${M11_ASSESSMENT_SUGGESTION_CONSUMER.consumerName}: payload has no ${key}`);
    }
    return value;
  };
  return {
    patientId: read("patientId"),
    assessmentId: read("assessmentId"),
    ruleId: read("ruleId"),
  };
}

/**
 * M11's live `m9.assessment.significant_change` binding — the §2.7 D7 order-suggestion banner.
 *
 * Idempotent two ways: `decideAssessmentSuggestion` itself answers `already_suggested` for a `triggeringId`
 * already on the banner (a redelivery), and `order_already_created` once the clinician's click-through has
 * produced a real order — a permanent skip, never re-raised, matching §2.7's "informative, never re-nagged"
 * rule.
 */
export function buildM11AssessmentSuggestionConsumer(deps: AssessmentSuggestionDeps) {
  return {
    consumerName: M11_ASSESSMENT_SUGGESTION_CONSUMER.consumerName,
    consumerModule: "m11" as const,
    eventTypes: [M11_ASSESSMENT_SUGGESTION_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const payload = factsOf(event.payload);
      const organizationId = event.organizationId;

      const banner = await readBanner(deps.redis, payload.patientId);
      const alreadySuggested = banner.some((e) => e.triggeringId === payload.assessmentId);

      const orderAlreadyCreated = await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const rows = await tx
            .select({ id: ORDER.id })
            .from(ORDER)
            .where(
              and(
                eq(ORDER.organizationId, organizationId),
                or(
                  eq(ORDER.triggeringAssessmentId, payload.assessmentId),
                  eq(ORDER.triggeringHopeAssessmentId, payload.assessmentId),
                ),
              ),
            )
            .limit(1);
          return rows.length > 0;
        },
      );

      const action = decideAssessmentSuggestion(payload, { alreadySuggested, orderAlreadyCreated });
      if (action.kind === "skip") return;

      const updated = [...banner, action.entry];
      await deps.redis.set(
        bannerKey(payload.patientId),
        JSON.stringify(updated),
        "EX",
        BANNER_TTL_SEC,
      );

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          await deps.outbox.publish(tx, {
            organizationId,
            eventName: "m11.order.suggestion_state_changed",
            aggregateKind: "patient",
            aggregateId: payload.patientId,
            payload: {
              patientId: payload.patientId,
              addedSuggestions: [action.entry.triggeringId],
              droppedSuggestions: [],
            },
          });
        },
      );
    },
  };
}

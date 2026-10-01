// apps/backend/src/bootstrap/outbox-consumers/m23-mac-portal-health.ts — M1's PLATFORM-scoped consumer for
// M23's §4.8 MAC-portal health probe (F-159/F-1xx, #248 — the m1 `no-consumer-surface` group's
// `m23.mac_portal.unavailable`/`.recovered` pair).
//
// `m23.mac_portal.unavailable`/`.recovered` are emitted with `organizationId: null`
// (`23-billing-medicare/jobs/m23-jobs.ts`'s `runMacPortalHealth`) — a MAC jurisdiction serves many
// provider entities across many tenants, so this is a genuinely platform-wide event with no single
// tenant it belongs to, the exact GAP-099 shape `m33.lag.exceeded`/`.recovered` already established.
// The dispatcher's SEPARATE `pollPlatform()` poll path (org-less rows, `PlatformOutboxConsumerBinding`)
// is what a consumer for this event type must bind through, never the ~150-strong org-scoped `consumers`
// array — this is the THIRD live `platformConsumers` entry the composition root wires, joining M40's
// `buildM29NppesPlatformConsumers` (the original GAP-099 pair) and M1's own `buildM1LagProbeStatusConsumer`
// (F-156, #248).
//
// `system_status` (M1 §3.10) is itself NON_ORG_SCOPED — no RLS, no `organization_id` column at all — so
// this write needs no `withOrgContext`/`withPlatformContext` envelope; a bare upsert on the shared `db`
// handle is correct. Idempotency needs no version check or conflict guard beyond Postgres's own
// `ON CONFLICT DO UPDATE`: the platform receipt table already dedupes a redelivery of the SAME event
// before `handle()` is ever called (the dispatcher's own `pollPlatform()` loop), and a genuinely later,
// different probe result simply overwrites the row with a newer status — the same "last write wins"
// semantics `SystemStatusReader.upsert`'s own admin route already carries for a human-authored status flip.
//
// One `system_status` component PER JURISDICTION (`mac_portal:<macJurisdiction>`, e.g. `mac_portal:ngs-j6`)
// — unlike the lag probe's single platform-wide `database_replication` row, a MAC-portal outage is scoped
// to ONE jurisdiction's submission channel, not the whole platform, so collapsing every jurisdiction onto
// one component id would report an unrelated jurisdiction's outage as a platform-wide one.
import { type DbClient, schema } from "@wardenx/db";
import type { PlatformDispatchableOutboxEvent } from "../outbox-dispatcher";

const MAC_PORTAL_COMPONENT_PREFIX = "mac_portal:";

export const M1_MAC_PORTAL_HEALTH_CONSUMER = {
  eventNames: ["m23.mac_portal.unavailable", "m23.mac_portal.recovered"] as const,
  consumerName: "m1.system-status.mac-portal-health",
} as const;

export interface MacPortalHealthStatusConsumerDeps {
  readonly db: DbClient;
}

interface UnavailableFacts {
  readonly macJurisdiction: string;
  readonly lastSeenUpAt: string | null;
  readonly downedAt: string;
}

interface RecoveredFacts {
  readonly macJurisdiction: string;
  readonly downedAt: string;
  readonly recoveredAt: string;
}

function unavailableFactsOf(payload: unknown): UnavailableFacts {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (
    typeof p.macJurisdiction !== "string" ||
    (typeof p.lastSeenUpAt !== "string" && p.lastSeenUpAt !== null) ||
    typeof p.downedAt !== "string"
  ) {
    throw new Error(
      `${M1_MAC_PORTAL_HEALTH_CONSUMER.consumerName}: malformed m23.mac_portal.unavailable payload`,
    );
  }
  return {
    macJurisdiction: p.macJurisdiction,
    lastSeenUpAt: p.lastSeenUpAt ?? null,
    downedAt: p.downedAt,
  };
}

function recoveredFactsOf(payload: unknown): RecoveredFacts {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (
    typeof p.macJurisdiction !== "string" ||
    typeof p.downedAt !== "string" ||
    typeof p.recoveredAt !== "string"
  ) {
    throw new Error(
      `${M1_MAC_PORTAL_HEALTH_CONSUMER.consumerName}: malformed m23.mac_portal.recovered payload`,
    );
  }
  return { macJurisdiction: p.macJurisdiction, downedAt: p.downedAt, recoveredAt: p.recoveredAt };
}

/**
 * M1's live platform-scoped binding for M23's §4.8 MAC-portal health probe. Flips the per-jurisdiction
 * `system_status` `"mac_portal:<macJurisdiction>"` component `degraded` on `.unavailable`, `operational`
 * on `.recovered` — the §4.9 platform status-page fact these two events exist to drive.
 */
export function buildM1MacPortalHealthConsumer(deps: MacPortalHealthStatusConsumerDeps) {
  return {
    consumerName: M1_MAC_PORTAL_HEALTH_CONSUMER.consumerName,
    consumerModule: "m1" as const,
    eventTypes: [...M1_MAC_PORTAL_HEALTH_CONSUMER.eventNames],
    async handle(event: PlatformDispatchableOutboxEvent): Promise<void> {
      const now = new Date();
      if (event.eventType === "m23.mac_portal.unavailable") {
        const facts = unavailableFactsOf(event.payload);
        const componentId = `${MAC_PORTAL_COMPONENT_PREFIX}${facts.macJurisdiction}`;
        const headline = `MAC portal (${facts.macJurisdiction}) unreachable`;
        const details = facts.lastSeenUpAt
          ? `Down since ${facts.downedAt} (last seen up ${facts.lastSeenUpAt}).`
          : `Down since ${facts.downedAt} (no prior up observation this process lifetime).`;
        await deps.db
          .insert(schema.systemStatus)
          .values({
            id: componentId,
            status: "degraded",
            headline,
            details,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: schema.systemStatus.id,
            set: { status: "degraded", headline, details, updatedAt: now },
          });
        return;
      }
      if (event.eventType === "m23.mac_portal.recovered") {
        const facts = recoveredFactsOf(event.payload);
        const componentId = `${MAC_PORTAL_COMPONENT_PREFIX}${facts.macJurisdiction}`;
        const details = `Recovered at ${facts.recoveredAt} (down since ${facts.downedAt}).`;
        await deps.db
          .insert(schema.systemStatus)
          .values({
            id: componentId,
            status: "operational",
            headline: null,
            details,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: schema.systemStatus.id,
            set: { status: "operational", headline: null, details, updatedAt: now },
          });
        return;
      }
      throw new Error(
        `${M1_MAC_PORTAL_HEALTH_CONSUMER.consumerName}: unexpected event type ${event.eventType}`,
      );
    },
  };
}

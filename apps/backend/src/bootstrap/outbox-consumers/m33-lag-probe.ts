// apps/backend/src/bootstrap/outbox-consumers/m33-lag-probe.ts — M1's PLATFORM-scoped consumer for
// M33's replica-lag probe (§4.10), GAP-099 (#248).
//
// `m33.lag.exceeded`/`.recovered` are emitted with `organizationId: null` (`m33-jobs.ts`'s `lagProbe`
// port, migration-0186 pattern — "the lag probe is an org-agnostic platform SINGLETON") — the dispatcher's
// SEPARATE `pollPlatform()` poll path (org-less rows, `PlatformOutboxConsumerBinding`) is what a consumer
// for this event type must bind through, never the ~150-strong org-scoped `consumers` array. This is the
// SECOND live `platformConsumers` entry the composition root wires, joining M40's `buildM29NppesPlatform
// Consumers` (GAP-099's original pair) — the mechanism was already proven live, not novel infrastructure.
//
// `system_status` (M1 §3.10) is itself NON_ORG_SCOPED — no RLS, no `organization_id` column at all — so
// this write needs no `withOrgContext`/`withPlatformContext` envelope; a bare upsert on the shared `db`
// handle is correct. Idempotency needs no version check or conflict guard beyond Postgres's own
// `ON CONFLICT DO UPDATE`: the platform receipt table (`report_writer_platform_receipt_exists`) already
// dedupes a redelivery of the SAME event before `handle()` is ever called (the dispatcher's own
// `pollPlatform()` loop), and a genuinely later, different lag sample simply overwrites the row with a
// newer status — the identical "last write wins" semantics `SystemStatusReader.upsert`'s own admin route
// already carries for a human-authored status flip.
import { type DbClient, schema } from "@wardenx/db";
import type { PlatformDispatchableOutboxEvent } from "../outbox-dispatcher";

/** The stable `system_status.id` this probe owns — matches the §4.9 M36 alert's own component naming. */
const LAG_PROBE_COMPONENT_ID = "database_replication";

export const M1_LAG_PROBE_CONSUMER = {
  eventNames: ["m33.lag.exceeded", "m33.lag.recovered"] as const,
  consumerName: "m1.system-status.lag-probe",
} as const;

export interface LagProbeStatusConsumerDeps {
  readonly db: DbClient;
}

interface LagExceededFacts {
  readonly lagSeconds: number;
  readonly threshold: number;
  readonly sampledAt: string;
}

interface LagRecoveredFacts {
  readonly lagSeconds: number;
  readonly durationDownSeconds: number;
}

function exceededFactsOf(payload: unknown): LagExceededFacts {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (
    typeof p.lagSeconds !== "number" ||
    typeof p.threshold !== "number" ||
    typeof p.sampledAt !== "string"
  ) {
    throw new Error(`${M1_LAG_PROBE_CONSUMER.consumerName}: malformed m33.lag.exceeded payload`);
  }
  return { lagSeconds: p.lagSeconds, threshold: p.threshold, sampledAt: p.sampledAt };
}

function recoveredFactsOf(payload: unknown): LagRecoveredFacts {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (typeof p.lagSeconds !== "number" || typeof p.durationDownSeconds !== "number") {
    throw new Error(`${M1_LAG_PROBE_CONSUMER.consumerName}: malformed m33.lag.recovered payload`);
  }
  return { lagSeconds: p.lagSeconds, durationDownSeconds: p.durationDownSeconds };
}

/**
 * M1's live platform-scoped binding for M33's §4.10 replica-lag probe (GAP-099). Flips the shared
 * `system_status` "database_replication" component `degraded` on `.exceeded`, `operational` on
 * `.recovered` — the §4.9 platform status-page fact these two events exist to drive.
 */
export function buildM1LagProbeStatusConsumer(deps: LagProbeStatusConsumerDeps) {
  return {
    consumerName: M1_LAG_PROBE_CONSUMER.consumerName,
    consumerModule: "m1" as const,
    eventTypes: [...M1_LAG_PROBE_CONSUMER.eventNames],
    async handle(event: PlatformDispatchableOutboxEvent): Promise<void> {
      const now = new Date();
      if (event.eventType === "m33.lag.exceeded") {
        const facts = exceededFactsOf(event.payload);
        await deps.db
          .insert(schema.systemStatus)
          .values({
            id: LAG_PROBE_COMPONENT_ID,
            status: "degraded",
            headline: "Database replication lag above threshold",
            details: `Lag ${facts.lagSeconds.toFixed(1)}s exceeds the ${facts.threshold.toFixed(1)}s threshold (sampled ${facts.sampledAt}).`,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: schema.systemStatus.id,
            set: {
              status: "degraded",
              headline: "Database replication lag above threshold",
              details: `Lag ${facts.lagSeconds.toFixed(1)}s exceeds the ${facts.threshold.toFixed(1)}s threshold (sampled ${facts.sampledAt}).`,
              updatedAt: now,
            },
          });
        return;
      }
      if (event.eventType === "m33.lag.recovered") {
        const facts = recoveredFactsOf(event.payload);
        await deps.db
          .insert(schema.systemStatus)
          .values({
            id: LAG_PROBE_COMPONENT_ID,
            status: "operational",
            headline: null,
            details: `Lag recovered to ${facts.lagSeconds.toFixed(1)}s after ${facts.durationDownSeconds.toFixed(0)}s degraded.`,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: schema.systemStatus.id,
            set: {
              status: "operational",
              headline: null,
              details: `Lag recovered to ${facts.lagSeconds.toFixed(1)}s after ${facts.durationDownSeconds.toFixed(0)}s degraded.`,
              updatedAt: now,
            },
          });
        return;
      }
      throw new Error(
        `${M1_LAG_PROBE_CONSUMER.consumerName}: unexpected event type ${event.eventType}`,
      );
    },
  };
}

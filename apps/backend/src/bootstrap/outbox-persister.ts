// apps/backend/src/bootstrap/outbox-persister.ts — M1-T10 transactional-outbox persister + boot catalog.
//
// packages/shared owns the catalog-validating dispatcher (`publishOutboxEvent`) but is a LEAF and may
// not import @wardenx/db, so the real Drizzle insert into `outbox_event` and the full boot catalog are
// assembled HERE, in the M1 composition layer (apps/backend), which CAN import @wardenx/{db,shared,types}.
// This file supplies three things the composition root wires:
//
//   1. buildBootOutboxCatalog([...module contributions]) — the FULL eventName→entry catalog (M1 + the
//      passed M30/M33/M34 `MNN_OUTBOX_EVENTS`). It is the `catalog` arg threaded into every publish so the
//      dispatcher validates the full taxonomy (unknown_event / namespace / payload), not just M1's.
//   2. buildTxOutboxPublisher(catalog) — the OutboxPublishPort the M30/M33 write services adopt: a per-call
//      `publish(tx, input)` that runs `publishOutboxEvent` and, only on success, inserts the row through the
//      CALLER'S tx (the same `withOrgContext` tx the mutation opened → transactional outbox). A validation
//      failure THROWS, rolling that tx back. M34 is intentionally NOT bound (its emit payloads are
//      non-conformant; its events are registered in the catalog for completeness only).
//   3. buildDbCatalogUpserter(db) + wireOutboxCatalog(db, catalog) — boot-populate `outbox_event_catalog`
//      from the full catalog (idempotent UPSERT on `event_name`).
import { type DbClient, schema } from "@wardenx/db";
import {
  type CatalogRowUpserter,
  M1_OUTBOX_EVENTS,
  buildOutboxEventCatalog,
  publishOutboxEvent,
  toOutboxCatalogRows,
} from "@wardenx/shared";
import type { ModuleEventContribution, OutboxEventEntry } from "@wardenx/types";
import { sql } from "drizzle-orm";

/**
 * The structural transaction handle a write service hands the publisher: the `withOrgContext` tx the
 * mutation already opened. Pinned to `DbClient` to MIRROR M34's `PlatformTx` (routes/platform/
 * service-drizzle.ts) — M30/M33 instantiate `withOrgContext<DbClient, T>` (QualityDb / WriteTx are both
 * `DbClient`), so the tx they pass satisfies this exactly and the insert runs on their transaction.
 */
export type OutboxTx = DbClient;

/** The envelope a write service publishes (validated against the catalog before it persists). */
export interface OutboxPublishInput {
  /** Fully-qualified `mN.<resource>.<verb>` event name — must be registered in the boot catalog. */
  readonly eventName: string;
  /** The event payload — Value.Check'd against the registered TypeBox `payloadSchema` (refuse-on-failure). */
  readonly payload: unknown;
  /** The tenant uuid the `outbox_event` row is keyed on. `null` ONLY for a genuinely platform-wide event
   *  (no single tenant it belongs to) — persisted with `organization_id IS NULL` under the
   *  `outbox_event_platform` RLS policy, which requires the caller's tx to have entered
   *  `withPlatformContext` (the `app.platform_context` GUC it sets, packages/tenancy/src/context.ts) —
   *  an org-scoped `withOrgContext` tx cannot satisfy that policy, so a caller cannot accidentally publish
   *  a platform-wide event from an ordinary tenant request. */
  readonly organizationId: string | null;
  /** Aggregate kind the event is about (e.g. `incident`, `report_schedule`). */
  readonly aggregateKind: string;
  /** Non-null aggregate uuid. */
  readonly aggregateId: string;
  /** The emitting module token (e.g. `m30`) — surfaced in namespace-mismatch errors. */
  readonly callerModule: string;
  /** When the event occurred; defaults to `new Date()` at publish time. */
  readonly occurredAt?: Date;
  /** Optional `outbox_event.id` (uuid) chosen by the caller, so it can store the id of the event it publishes in the same
   *  transaction (the port returns void). Omitted: the table default. Not allowed with a null organization. */
  readonly eventId?: string;
}

/**
 * Catalog-validated outbox publish over the caller's tx. The composition root binds this for M30 and M33
 * (NOT M34). A write service calls `publish(tx, input)` once per emitted event inside its `withOrgContext`
 * tx; the row commits atomically with the mutation, and a non-conformant payload rolls the tx back.
 */
export interface OutboxPublishPort {
  publish(tx: OutboxTx, input: OutboxPublishInput): Promise<void>;
}

/**
 * The FULL boot catalog: M1's own contributions merged with every passed module contribution
 * (M30/M33/M34 `MNN_OUTBOX_EVENTS`). Delegates to the shared collision-checked builder, so two modules
 * declaring the same `eventName` fail boot. This map is the `catalog` arg every publish validates against.
 */
export function buildBootOutboxCatalog(
  moduleContributions: readonly ModuleEventContribution[],
): ReadonlyMap<string, OutboxEventEntry> {
  return buildOutboxEventCatalog([M1_OUTBOX_EVENTS, ...moduleContributions]);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the OutboxPublishPort. Each `publish` runs the shared dispatcher against `catalog`; on success its
 * injected persister inserts the `outbox_event` row through the caller's `tx` (`event_type` = the event
 * name). Mapping: OutboxRecord → outbox_event insert. `status`/`attempt_count`/`created_at` take their
 * table defaults (`pending`/0/now()).
 *
 * A NULL `organizationId` (a genuinely platform-wide event — no single tenant it belongs to) does NOT go
 * through the plain Drizzle insert: `wardenx_app` has no RLS policy admitting a `organization_id IS NULL`
 * write (ADR-0010 D2/D3 forbid one — see migration 0186's own comment for why). It calls the SECURITY
 * DEFINER `report_writer_insert_platform_outbox_event` function instead (migration 0186) — owned by
 * `report_writer`, EXECUTE granted directly to `wardenx_app`, touches `organization_id IS NULL` rows only
 * (hardcoded in the function body, never a caller-supplied parameter).
 */
export function buildTxOutboxPublisher(
  catalog: ReadonlyMap<string, OutboxEventEntry>,
): OutboxPublishPort {
  return {
    async publish(tx, input) {
      if (
        input.eventId !== undefined &&
        (input.organizationId === null || !UUID_RE.test(input.eventId))
      ) {
        throw new Error("outbox publish: eventId must be a uuid and needs an organization");
      }
      await publishOutboxEvent(
        {
          eventName: input.eventName,
          payload: input.payload,
          organizationId: input.organizationId,
          aggregateKind: input.aggregateKind,
          aggregateId: input.aggregateId,
          callerModule: input.callerModule,
          occurredAt: input.occurredAt ?? new Date(),
          ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
        },
        async (record) => {
          if (record.organizationId === null) {
            await tx.execute(sql`
              SELECT report_writer_insert_platform_outbox_event(
                ${record.eventName},
                ${record.aggregateKind},
                ${record.aggregateId},
                ${JSON.stringify(record.payload)}::jsonb
              )
            `);
            return;
          }
          await tx.insert(schema.outboxEvents).values({
            ...(record.eventId === undefined ? {} : { id: record.eventId }),
            eventType: record.eventName,
            organizationId: record.organizationId,
            aggregateKind: record.aggregateKind,
            aggregateId: record.aggregateId,
            payload: record.payload,
          });
        },
        catalog,
      );
    },
  };
}

/**
 * Build the idempotent `outbox_event_catalog` row UPSERTer (insert-or-update on the `event_name` PK), so
 * re-running boot re-registers cleanly. The platform pool is passed (this is platform reference data,
 * NON_ORG_SCOPED).
 */
export function buildDbCatalogUpserter(db: DbClient): CatalogRowUpserter {
  const T = schema.outboxEventCatalog;
  // `seamConsumers` (#103) is deliberately NOT projected here. `outbox_event_catalog` exists so the
  // database can answer "what does this event mean and who subscribes to it"; the seam list answers a
  // different question (who receives the information by a synchronous call instead), is documentation
  // rather than routing, and would cost a migration to carry. The in-code catalog stays its home.
  return async (row) => {
    await db
      .insert(T)
      .values({
        eventName: row.eventName,
        moduleOwner: row.moduleOwner,
        description: row.description,
        payloadSchema: row.payloadSchema,
        declaredConsumers: row.declaredConsumers,
        isOutboxOnly: row.isOutboxOnly,
      })
      .onConflictDoUpdate({
        target: T.eventName,
        set: {
          moduleOwner: row.moduleOwner,
          description: row.description,
          payloadSchema: row.payloadSchema,
          declaredConsumers: row.declaredConsumers,
          isOutboxOnly: row.isOutboxOnly,
        },
      });
  };
}

/**
 * Boot-populate `outbox_event_catalog` from the FULL catalog (idempotent). Mirrors the shared
 * `bootOutboxEventCatalog` loop, but over the full `catalog` rows rather than its M1-only default
 * (`toOutboxCatalogRows()` with no arg projects only M1's contributions) — so every M30/M33/M34 event is
 * registered. Call once during the backend boot sequence with the platform DB handle.
 */
export async function wireOutboxCatalog(
  db: DbClient,
  catalog: ReadonlyMap<string, OutboxEventEntry>,
): Promise<void> {
  const upsert = buildDbCatalogUpserter(db);
  for (const row of toOutboxCatalogRows([...catalog.values()])) {
    await upsert(row);
  }
}

// @chartwarden/shared — Outbox catalog boot projection (M1 Foundation §3.17.4).
//
// Projects the validated OUTBOX_EVENT_CATALOG into the rows persisted in the
// `outbox_event_catalog` table. The actual write is dependency-injected: the real
// Drizzle `db` handle + boot sequencing land with the backend bootstrap (M1-T09/T10),
// so this stays a pure leaf here (no `@chartwarden/db` import — packages/shared is a leaf)
// and is wired then, mirroring the injected-writer pattern in the org-settings boot.
import type { OutboxEventCatalogRow } from "@chartwarden/types";
import { OUTBOX_EVENT_CATALOG } from "./registry";

/** The persisted form of every catalog entry (insert-or-update on `event_name`). */
export function toOutboxCatalogRows(
  catalog: typeof OUTBOX_EVENT_CATALOG = OUTBOX_EVENT_CATALOG,
): OutboxEventCatalogRow[] {
  return catalog.map((entry) => ({
    eventName: entry.eventName,
    moduleOwner: entry.moduleOwner,
    description: entry.description,
    payloadSchema: entry.payloadSchema,
    declaredConsumers: [...entry.declaredConsumers],
    isOutboxOnly: entry.isOutboxOnly,
  }));
}

/** UPSERTs one catalog row (insert-or-update on `event_name`). Injected at boot. */
export type CatalogRowUpserter = (row: OutboxEventCatalogRow) => Promise<void>;

/**
 * Boot-populates `outbox_event_catalog` from the in-code catalog, UPSERTing each row so
 * re-runs are idempotent. Called once during the backend boot sequence (M1-T09/T10) with
 * a Drizzle-backed `upsert` (`db.insert(...).onConflictDoUpdate(...)`).
 */
export async function bootOutboxEventCatalog(upsert: CatalogRowUpserter): Promise<void> {
  for (const row of toOutboxCatalogRows()) {
    await upsert(row);
  }
}

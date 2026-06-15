// @wardenx/shared — Outbox Event Catalog aggregator (M1 Foundation §3.17).
//
// Aggregates every module's ModuleEventContribution (events-by-mN.ts) into one
// validated catalog map, mirroring the organization-settings registry pattern. The
// build is FAIL-CLOSED: two modules declaring the same `eventName` throws
// OutboxEventCollisionError rather than letting one silently shadow the other
// (spec §3.17.4 collision check). The map is the source the dispatcher validates each
// publish against (unknown_event / namespace / payload — see ../outbox/publish.ts).
import type { ModuleEventContribution, OutboxEventEntry } from "@wardenx/types";
import { M1_OUTBOX_EVENTS } from "./events-by-m1";

// Every producer module appends its events-by-mN.ts contribution here.
const CONTRIBUTIONS: readonly ModuleEventContribution[] = [
  M1_OUTBOX_EVENTS,
  // future module contributions append here
];

/** Thrown when two modules register the same `eventName` (spec §3.17.4 collision check). */
export class OutboxEventCollisionError extends Error {
  constructor(
    readonly eventName: string,
    readonly firstModule: string,
    readonly secondModule: string,
  ) {
    super(
      `outbox_event_collision: '${eventName}' is registered by both '${firstModule}' and ` +
        `'${secondModule}' — an event name may be owned by one module only`,
    );
    this.name = "OutboxEventCollisionError";
  }
}

/**
 * Aggregates `contributions` into an eventName→entry map, rejecting duplicates.
 * Pure and total over its input — pass synthetic contributions to unit-test the guard.
 */
export function buildOutboxEventCatalog(
  contributions: readonly ModuleEventContribution[] = CONTRIBUTIONS,
): ReadonlyMap<string, OutboxEventEntry> {
  const byName = new Map<string, OutboxEventEntry>();
  for (const contribution of contributions) {
    for (const entry of contribution) {
      const existing = byName.get(entry.eventName);
      if (existing) {
        throw new OutboxEventCollisionError(
          entry.eventName,
          existing.moduleOwner,
          entry.moduleOwner,
        );
      }
      byName.set(entry.eventName, entry);
    }
  }
  return byName;
}

/** The validated, boot-time outbox event catalog (collision-free). */
export const OUTBOX_EVENT_CATALOG_MAP = buildOutboxEventCatalog();

/** Flat view of the catalog — projected to `outbox_event_catalog` rows at boot. */
export const OUTBOX_EVENT_CATALOG: readonly OutboxEventEntry[] = [
  ...OUTBOX_EVENT_CATALOG_MAP.values(),
];

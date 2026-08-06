// @wardenx/shared — Outbox publisher with catalog validation (M1 Foundation §3.17.3).
//
// `publishOutboxEvent` is the ONLY sanctioned way to emit a cross-module event. Before
// the row is persisted it validates, in order:
//   (a) the event name is registered in the catalog          → W-M1-09 unknown_event
//   (b) the caller owns the event's `mN.` namespace          → namespace_mismatch
//   (c) the payload conforms to the registered TypeBox schema → W-M1-11 payload_schema_violation
// Any failure throws OutboxEventValidationError and NOTHING is persisted; because the
// persist runs inside the caller's transaction, the whole transaction rolls back
// (spec §3.17, W-M1-09/§7.8, W-M1-11/§7.10).
//
// The persist itself is dependency-injected (OutboxPersister): packages/shared is a
// leaf and never imports @wardenx/db, so the real Drizzle insert into `outbox_event`
// is supplied by the M1 backend bootstrap (M1-T10) and threaded through the caller's tx.
import { Value } from "@sinclair/typebox/value";
import type { OutboxEventEntry } from "@wardenx/types";
import { OUTBOX_EVENT_CATALOG_MAP } from "../outbox-events/registry";

export type OutboxEventViolation =
  | "unknown_event"
  | "namespace_mismatch"
  | "payload_schema_violation";

/** Thrown when a publish fails catalog validation; the calling transaction rolls back. */
export class OutboxEventValidationError extends Error {
  constructor(
    readonly eventName: string,
    readonly violation: OutboxEventViolation,
    readonly details: string,
  ) {
    super(`outbox_event_validation: ${eventName} — ${violation} — ${details}`);
    this.name = "OutboxEventValidationError";
  }
}

/** The validated record the dispatcher hands to the injected persister. `organizationId` is `null` only
 *  for a genuinely platform-wide event (no single tenant it belongs to, e.g. a cross-tenant MV refresh or
 *  the replica-lag probe) — never a stand-in for "unknown" or "not yet resolved." */
export interface OutboxRecord {
  readonly eventName: string;
  readonly payload: unknown;
  readonly organizationId: string | null;
  readonly aggregateKind: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
}

/**
 * Persists a validated outbox record inside the caller's transaction. Injected at boot
 * (the real impl inserts the `outbox_event` row via Drizzle — packages/shared, a leaf,
 * never imports @wardenx/db). Throwing here rolls the caller's transaction back.
 */
export type OutboxPersister = (record: OutboxRecord) => Promise<void>;

export interface PublishOutboxEventInput {
  readonly eventName: string;
  readonly payload: unknown;
  readonly organizationId: string | null;
  readonly aggregateKind: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
  /** The module emitting the event, e.g. `m1` — surfaced in namespace-mismatch errors (M01-F12). */
  readonly callerModule: string;
}

/**
 * Validates `input` against the outbox catalog and, only if it passes all three checks,
 * delegates to `persist`. Throws OutboxEventValidationError on the first failure.
 * `catalog` is injectable for unit tests; defaults to the boot catalog.
 */
export async function publishOutboxEvent(
  input: PublishOutboxEventInput,
  persist: OutboxPersister,
  catalog: ReadonlyMap<string, OutboxEventEntry> = OUTBOX_EVENT_CATALOG_MAP,
): Promise<void> {
  // (a) registered?
  const entry = catalog.get(input.eventName);
  if (!entry) {
    throw new OutboxEventValidationError(
      input.eventName,
      "unknown_event",
      `event '${input.eventName}' is not registered in the outbox catalog (add it to events-by-${input.callerModule}.ts)`,
    );
  }

  // (b) the caller owns the event's namespace (M01-F12: compare callerModule to the
  //     event's moduleOwner). `sud.*` is the one cross-module subdomain multiple modules
  //     may emit (M4 v0.3 D9), routed by module_owner mapping — allowed from any caller.
  const namePrefix = input.eventName.split(".")[0];
  if (input.callerModule !== entry.moduleOwner && namePrefix !== "sud") {
    throw new OutboxEventValidationError(
      input.eventName,
      "namespace_mismatch",
      `event '${input.eventName}' is owned by '${entry.moduleOwner}' but was published from '${input.callerModule}'`,
    );
  }

  // (c) payload conforms to the registered TypeBox schema (W-M1-11).
  if (!Value.Check(entry.payloadSchema, input.payload)) {
    const details = [...Value.Errors(entry.payloadSchema, input.payload)]
      .map((e) => `${e.path || "/"}: ${e.message}`)
      .join("; ");
    throw new OutboxEventValidationError(
      input.eventName,
      "payload_schema_violation",
      `payload validation failed: ${details}`,
    );
  }

  await persist({
    eventName: input.eventName,
    payload: input.payload,
    organizationId: input.organizationId,
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
  });
}

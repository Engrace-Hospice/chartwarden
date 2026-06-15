// @wardenx/types — Outbox event contracts (M1 Foundation §3.17; M1-T08).
//
// Per ADR-0005 D1, consuming another module via an OUTBOX event needs NO dependsOn
// edge: the event NAME + PAYLOAD type live here in a leaf, and delivery is runtime-
// wired through the M1 outbox dispatcher (packages/shared). Per M01 D8 / M03 D9 every
// event name follows `mN.<resource>.<verb>` and the declaring module owns the `mN.`
// prefix — check-fitness-gaps.ts enforces this against events-by-mN.ts contribution
// files as they land. The catalog-entry types below are the contribution shape every
// producer module ships (spec §3.17.2); the dispatcher in packages/shared validates
// each publish against the registered TypeBox `payloadSchema` (refuse-on-failure).
import type { TSchema } from "@sinclair/typebox";

/** Event-name convention: `m<moduleId>.<resource>.<verb>` (M01 D8 / M03 D9). */
export type OutboxEventName = `m${number}.${string}.${string}`;

/** A module id token (`m1`, `m11`, …) — the `mN.` namespace owner / declared consumer. */
export type ModuleToken = `m${number}`;

/**
 * One registered outbox event (M1 §3.17.2). A producer module ships a
 * ModuleEventContribution (a `readonly OutboxEventEntry[]`) in its events-by-mN.ts;
 * the M1 boot UPSERTs each into `outbox_event_catalog` and the dispatcher validates
 * every publish against it.
 */
export interface OutboxEventEntry<TName extends OutboxEventName = OutboxEventName> {
  /** Fully-qualified event name, e.g. `m1.system_status.changed`. */
  readonly eventName: TName;
  /** The owning module's `mN` token — must match the event name's `mN.` prefix. */
  readonly moduleOwner: ModuleToken;
  /** Human-readable description of what the event signals. */
  readonly description: string;
  /** TypeBox schema every published payload must satisfy (W-M1-11). */
  readonly payloadSchema: TSchema;
  /** Module ids declared as consumers (validated against real module ids); empty = broadcast. */
  readonly declaredConsumers: readonly ModuleToken[];
  /** When false, the event is ALSO pushed over Socket.IO (not outbox-only). */
  readonly isOutboxOnly: boolean;
}

/** One module's outbox-event contribution: the events it OWNS under its `mN.` prefix. */
export type ModuleEventContribution = readonly OutboxEventEntry[];

/**
 * Persisted projection of a catalog entry into the `outbox_event_catalog` row shape.
 * Structural (no `@wardenx/db` import) so packages/shared stays a leaf — the M1 boot
 * sequence (M1-T09/T10) feeds these rows to an injected Drizzle UPSERTer.
 */
export interface OutboxEventCatalogRow {
  readonly eventName: string;
  readonly moduleOwner: string;
  readonly description: string;
  readonly payloadSchema: unknown;
  readonly declaredConsumers: string[];
  readonly isOutboxOnly: boolean;
}

/** The envelope every outbox event is published with. */
export interface OutboxEvent<TName extends OutboxEventName = OutboxEventName, TPayload = unknown> {
  readonly eventName: TName;
  readonly orgId: string;
  /** Aggregate the event is about (e.g. a patient id, claim id). */
  readonly aggregateId: string;
  readonly payload: TPayload;
  /** Module ids declared as consumers (validated against real module ids). */
  readonly consumers?: readonly `m${number}`[];
}

/**
 * A module's outbox contribution: the events it OWNS (its `mN.` prefix). Producer
 * modules ship an events-by-mN.ts exporting one of these; check-fitness-gaps.ts scans
 * those files for naming + ownership + valid consumers.
 */
export interface OutboxCatalogContribution {
  readonly moduleId: number;
  readonly events: ReadonlyArray<{
    readonly eventName: OutboxEventName;
    readonly consumers?: readonly `m${number}`[];
  }>;
}

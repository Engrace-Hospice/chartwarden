// @wardenx/types — Outbox event contracts (Phase 0 skeleton).
//
// Per ADR-0005 D1, consuming another module via an OUTBOX event needs NO dependsOn
// edge: the event NAME + PAYLOAD type live here in a leaf, and delivery is runtime-
// wired through the M1 outbox dispatcher (packages/shared). Per M01 D8 / M03 D9 every
// event name follows `mN.<resource>.<verb>` and the declaring module owns the `mN.`
// prefix — check-fitness-gaps.ts enforces this against events-by-mN.ts contribution
// files as they land. Phase 0 ships only the shared envelope shape.

/** Event-name convention: `m<moduleId>.<resource>.<verb>` (M01 D8 / M03 D9). */
export type OutboxEventName = `m${number}.${string}.${string}`;

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

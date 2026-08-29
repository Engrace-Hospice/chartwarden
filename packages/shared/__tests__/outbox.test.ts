/**
 * M1-T08 — Outbox dispatcher + event catalog (spec §3.17).
 *
 * Accept criteria exercised here:
 *   - W-M1-09 (§7.8): publishing an unknown event is refused (unknown_event), nothing persisted.
 *   - W-M1-11 (§7.10): a payload that violates the registered TypeBox schema is refused
 *     (payload_schema_violation), nothing persisted.
 *   - namespace ownership: a caller cannot emit under another module's `mN.` prefix.
 *   - §3.17.4 collision: two contributions sharing an eventName fail the catalog build.
 *   - happy path: a valid publish reaches the injected persister exactly once.
 */
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  M1_OUTBOX_EVENTS,
  OUTBOX_EVENT_CATALOG,
  OUTBOX_EVENT_CATALOG_MAP,
  OutboxEventCollisionError,
  OutboxEventValidationError,
  buildOutboxEventCatalog,
  publishOutboxEvent,
  toOutboxCatalogRows,
} from "../src/index";
import type { OutboxRecord, PublishOutboxEventInput } from "../src/outbox/publish";

const base: Omit<PublishOutboxEventInput, "eventName" | "payload"> = {
  organizationId: "00000000-0000-0000-0000-000000000001",
  aggregateKind: "feature_flag",
  aggregateId: "00000000-0000-0000-0000-0000000000aa",
  occurredAt: new Date("2026-06-14T00:00:00.000Z"),
  callerModule: "m1",
};

const validFlagPayload = {
  organizationId: "00000000-0000-0000-0000-000000000001",
  key: "hearthnote.layer2",
  value: false,
};

describe("buildOutboxEventCatalog — collision rejection (§3.17.4)", () => {
  it("rejects two contributions declaring the same eventName", () => {
    const dup = (mod: "m1") =>
      [
        {
          eventName: "m1.feature_flag.updated",
          moduleOwner: mod,
          description: "dup",
          payloadSchema: Type.Object({}),
          declaredConsumers: [],
          isOutboxOnly: true,
        },
      ] as const satisfies ModuleEventContribution;
    expect(() => buildOutboxEventCatalog([dup("m1"), dup("m1")])).toThrow(
      OutboxEventCollisionError,
    );
  });

  it("M1 contribution builds collision-free and is exposed in the boot catalog", () => {
    expect(OUTBOX_EVENT_CATALOG_MAP.has("m1.system_status.changed")).toBe(true);
    expect(OUTBOX_EVENT_CATALOG_MAP.has("m1.feature_flag.updated")).toBe(true);
    expect(OUTBOX_EVENT_CATALOG.length).toBe(M1_OUTBOX_EVENTS.length);
  });
});

describe("publishOutboxEvent — catalog validation", () => {
  let persist: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    persist = vi.fn(async (_r: OutboxRecord) => {});
  });

  it("refuses an unknown event (W-M1-09) and persists nothing", async () => {
    await expect(
      publishOutboxEvent({ ...base, eventName: "m11.order.fictional_event", payload: {} }, persist),
    ).rejects.toMatchObject({ violation: "unknown_event" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("refuses a cross-namespace publish — a caller emitting another module's event (M01-F12)", async () => {
    // m9 trying to publish m1's registered event: callerModule ('m9') ≠ owner ('m1').
    await expect(
      publishOutboxEvent(
        {
          ...base,
          callerModule: "m9",
          eventName: "m1.feature_flag.updated",
          payload: validFlagPayload,
        },
        persist,
      ),
    ).rejects.toMatchObject({ violation: "namespace_mismatch" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("refuses a payload that violates the registered schema (W-M1-11) and persists nothing", async () => {
    await expect(
      publishOutboxEvent(
        // omit `key` + `organizationId` → schema violation
        { ...base, eventName: "m1.feature_flag.updated", payload: { value: 1 } },
        persist,
      ),
    ).rejects.toMatchObject({ violation: "payload_schema_violation" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("OutboxEventValidationError message names the event and violation", async () => {
    const err = await publishOutboxEvent(
      { ...base, eventName: "m9.unknown.thing", payload: {} },
      persist,
    ).then(
      () => null,
      (e: unknown) => e as OutboxEventValidationError,
    );
    expect(err).toBeInstanceOf(OutboxEventValidationError);
    // `.then(resolve → null)` rather than `.catch`: `publishOutboxEvent` resolves to void, so the
    // `.catch` form widened `err` to `void | OutboxEventValidationError` and a RESOLVED publish — the
    // failure this case exists to catch — would have read as an absent message rather than a failure.
    expect(err?.message).toContain("m9.unknown.thing");
    expect(err?.message).toContain("unknown_event");
  });

  it("persists a valid event exactly once with the normalized record", async () => {
    await publishOutboxEvent(
      { ...base, eventName: "m1.feature_flag.updated", payload: validFlagPayload },
      persist,
    );
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({
      eventName: "m1.feature_flag.updated",
      payload: validFlagPayload,
      organizationId: base.organizationId,
      aggregateKind: base.aggregateKind,
      aggregateId: base.aggregateId,
      occurredAt: base.occurredAt,
    });
  });
});

describe("toOutboxCatalogRows — boot projection", () => {
  it("projects every catalog entry into a persistable row", () => {
    const rows = toOutboxCatalogRows();
    expect(rows.map((r) => r.eventName).sort()).toEqual([
      "m1.feature_flag.updated",
      "m1.system_status.changed",
    ]);
    for (const row of rows) {
      expect(row.moduleOwner).toBe("m1");
      expect(Array.isArray(row.declaredConsumers)).toBe(true);
      expect(row.payloadSchema).toBeDefined();
    }
  });
});

// WP 3.4 - the four task outbox events: catalogued, outbox-only, PHI-free, and the payloads task-events.ts builds validate
// against the catalog schemas (so the real catalog-validating publisher accepts them).
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import {
  M36_TASK_EVENTS,
  type TaskEventFacts,
  taskEventPayload,
} from "../src/modules/36-messaging/tasks/task-events";

const U = "11111111-1111-4111-8111-111111111111";
const AT = new Date("2026-10-14T12:00:00.000Z");
const base = { orgId: U, taskId: U, channelId: U, at: AT };

const FACTS: Record<keyof typeof M36_TASK_EVENTS, TaskEventFacts> = {
  created: {
    ...base,
    kind: "created",
    messageId: U,
    assigneeUserId: U,
    createdByUserId: U,
  },
  reassigned: { ...base, kind: "reassigned", fromUserId: U, toUserId: U, source: "offboarding" },
  needsOwner: { ...base, kind: "needsOwner", creatorUserId: U },
  statusChanged: { ...base, kind: "statusChanged", from: "open", to: "done" },
};

const entry = (name: string) => M36_OUTBOX_EVENTS.find((e) => e.eventName === name);

describe("m36.task.* outbox catalog", () => {
  it("catalogues exactly the four task events, owned by m36 and outbox-only", () => {
    const names = M36_OUTBOX_EVENTS.map((e) => e.eventName).filter((n) =>
      n.startsWith("m36.task."),
    );
    expect(names.sort()).toEqual(Object.values(M36_TASK_EVENTS).sort());
    for (const name of names) {
      expect(entry(name)).toMatchObject({ moduleOwner: "m36", isOutboxOnly: true });
    }
  });

  it("declares the m36 consumer for created, reassigned and needs_owner and none for status_changed", () => {
    expect(entry("m36.task.created")?.declaredConsumers).toEqual(["m36"]);
    expect(entry("m36.task.reassigned")?.declaredConsumers).toEqual(["m36"]);
    expect(entry("m36.task.needs_owner")?.declaredConsumers).toEqual(["m36"]);
    expect(entry("m36.task.status_changed")?.declaredConsumers).toEqual([]);
  });

  it.each(Object.entries(M36_TASK_EVENTS))(
    "the %s payload built by task-events validates against its catalog schema",
    (kind, eventName) => {
      const payload = taskEventPayload(FACTS[kind as keyof typeof FACTS]);
      expect(Value.Check(entry(eventName)?.payloadSchema as never, payload)).toBe(true);
    },
  );

  it("accepts the review source on a reassignment and rejects an unknown one", () => {
    const schema = entry("m36.task.reassigned")?.payloadSchema as never;
    const review = taskEventPayload({ ...FACTS.reassigned, source: "review" } as TaskEventFacts);
    expect(Value.Check(schema, review)).toBe(true);
    expect(Value.Check(schema, { ...review, source: "handoff" })).toBe(false);
  });

  it.each(Object.values(M36_TASK_EVENTS))(
    "%s schema carries no patient or reason key",
    (eventName) => {
      const keys = Object.keys(
        (entry(eventName)?.payloadSchema as unknown as { properties: object }).properties,
      );
      for (const forbidden of [
        "patientId",
        "patient_id",
        "reason",
        "reasonCode",
        "closedReason",
        "body",
      ]) {
        expect(keys).not.toContain(forbidden);
      }
    },
  );

  it("rejects an extra patientId at the schema boundary", () => {
    const payload = { ...taskEventPayload(FACTS.created), patientId: U };
    expect(Value.Check(entry("m36.task.created")?.payloadSchema as never, payload)).toBe(false);
  });
});

// ADR-0082 S1 / decision 7 - a caller may supply the outbox event id so it can store the id of the event it publishes in the SAME
// transaction (the port returns void). Omitted: the table default is used, as before. A non-uuid id is refused before any insert.
import { describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";

const U = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M36_OUTBOX_EVENTS]));
const input = {
  eventName: "m36.afterhours_triage.requested",
  payload: { messageId: U, requestId: U, patientId: U, occurredAt: "2026-10-19T12:00:00.000Z" },
  organizationId: U,
  aggregateKind: "message",
  aggregateId: U,
  callerModule: "m36",
};
const fakeTx = () => {
  const rows: Record<string, unknown>[] = [];
  const tx = { insert: () => ({ values: async (v: Record<string, unknown>) => void rows.push(v) }) };
  return { tx: tx as never, rows };
};

describe("OutboxPublishInput.eventId", () => {
  it("is written as the outbox_event id when supplied", async () => {
    const { tx, rows } = fakeTx();
    await publisher.publish(tx, { ...input, eventId: EVENT_ID });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(EVENT_ID);
  });

  it("leaves the id to the table default when omitted (existing callers unchanged)", async () => {
    const { tx, rows } = fakeTx();
    await publisher.publish(tx, input);
    expect(rows).toHaveLength(1);
    expect("id" in (rows[0] ?? {})).toBe(false);
  });

  it("refuses a non-uuid id and inserts nothing", async () => {
    const { tx, rows } = fakeTx();
    await expect(publisher.publish(tx, { ...input, eventId: "nope" })).rejects.toThrow(/eventId/);
    expect(rows).toHaveLength(0);
  });

  it("refuses an id on a platform-wide (null organization) event", async () => {
    const { tx, rows } = fakeTx();
    await expect(
      publisher.publish(tx, { ...input, organizationId: null, eventId: EVENT_ID }),
    ).rejects.toThrow(/eventId/);
    expect(rows).toHaveLength(0);
  });
});

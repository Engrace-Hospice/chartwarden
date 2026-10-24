// ADR-0082 slices S3/S4: the request writer, the thread-line map and the outcome consumer, over in-memory fakes.
import { AFTERHOURS_TRIAGE_LINE_TEXT } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import type { DispatchableOutboxEvent } from "../../../bootstrap/outbox-dispatcher";
import { buildM36AfterHoursOutcomeConsumer } from "../outbox-consumers/afterhours-outcome";
import { createAfterHoursLinesService, lineStateOf } from "./afterhours-lines";
import type { AfterHoursLinkStore, RecordOutcomeResult } from "./afterhours-link-store";
import { afterHoursRequestedPayload, createAfterHoursRequestWriter } from "./afterhours-request";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const MSG = "00000000-0000-4000-8000-0000000000b1";
const REQ = "00000000-0000-4000-8000-0000000000b2";
const PAT = "00000000-0000-4000-8000-0000000000b3";
const EVT = "00000000-0000-4000-8000-0000000000e1";
const CALL = "00000000-0000-4000-8000-0000000000c1";
const CH = "00000000-0000-4000-8000-0000000000d1";
const AT = new Date("2026-10-20T03:00:00.000Z");

describe("the request writer (S3)", () => {
  it("publishes the id-only event with a chosen event id and stores the SAME id on the link, in the same tx", async () => {
    const published: Record<string, unknown>[] = [];
    const links: Record<string, unknown>[] = [];
    const tx = { marker: "tx" };
    const write = createAfterHoursRequestWriter({
      outbox: {
        publish: async (t, e) => {
          expect(t).toBe(tx);
          published.push(e as unknown as Record<string, unknown>);
        },
      },
      store: {
        insertInTx: async (t, l) => {
          expect(t).toBe(tx);
          links.push(l as unknown as Record<string, unknown>);
        },
      },
      newEventId: () => EVT,
    });

    await write(tx, { orgId: ORG, messageId: MSG, requestId: REQ, patientId: PAT, at: AT });

    expect(published).toEqual([
      {
        eventName: "m36.afterhours_triage.requested",
        organizationId: ORG,
        aggregateKind: "message",
        aggregateId: MSG,
        payload: { messageId: MSG, requestId: REQ, patientId: PAT, occurredAt: AT.toISOString() },
        eventId: EVT,
      },
    ]);
    expect(links).toEqual([
      { orgId: ORG, messageId: MSG, requestId: REQ, sourceOutboxEventId: EVT },
    ]);
  });

  it("the payload is exactly the frozen id-only shape (no organization, no text)", () => {
    expect(
      Object.keys(
        afterHoursRequestedPayload({
          orgId: ORG,
          messageId: MSG,
          requestId: REQ,
          patientId: PAT,
          at: AT,
        }),
      ).sort(),
    ).toEqual(["messageId", "occurredAt", "patientId", "requestId"]);
  });

  it("fails the send whole when no outbox is bound (never a link nobody will answer)", async () => {
    const write = createAfterHoursRequestWriter({
      outbox: undefined,
      store: { insertInTx: async () => undefined },
    });
    await expect(
      write(null, { orgId: ORG, messageId: MSG, requestId: REQ, patientId: PAT, at: AT }),
    ).rejects.toThrow(/outbox/);
  });
});

describe("the thread line (S4)", () => {
  const store = (
    rows: { messageId: string; outcome: "opened" | "coalesced" | "no_coverage" | null }[],
  ): Pick<AfterHoursLinkStore, "findForChannel"> => ({ findForChannel: async () => rows });

  it("derives every line from the closed map; an unanswered request is 'triage call not confirmed'", async () => {
    const service = createAfterHoursLinesService({
      isEnabled: async () => true,
      store: store([
        { messageId: "m1", outcome: null },
        { messageId: "m2", outcome: "opened" },
        { messageId: "m3", outcome: "coalesced" },
        { messageId: "m4", outcome: "no_coverage" },
      ]),
      isRestrictedChannel: async () => false,
    });
    const { lines } = await service.forChannel(ORG, CH, ["m1", "m2", "m3", "m4"]);
    expect(lines.map((l) => l.state)).toEqual([
      "not_confirmed",
      "opened",
      "coalesced",
      "no_coverage",
    ]);
    for (const l of lines) expect(l.text).toBe(AFTERHOURS_TRIAGE_LINE_TEXT[l.state]);
    expect(AFTERHOURS_TRIAGE_LINE_TEXT.not_confirmed).toBe("Triage call not confirmed");
  });

  it("withholds the outcome wording in a restricted channel, and also when the restriction cannot be read", async () => {
    for (const isRestrictedChannel of [
      async () => true,
      async () => {
        throw new Error("seam down");
      },
    ]) {
      const service = createAfterHoursLinesService({
        isEnabled: async () => true,
        store: store([
          { messageId: "m1", outcome: "no_coverage" },
          { messageId: "m2", outcome: null },
        ]),
        isRestrictedChannel,
      });
      const { lines } = await service.forChannel(ORG, CH, ["m1", "m2"]);
      expect(lines.map((l) => l.state)).toEqual(["withheld", "withheld"]);
      expect(JSON.stringify(lines)).not.toMatch(/opened|coverage/i);
    }
  });

  it("is the uniform 404 with the flag off and reads nothing", async () => {
    let read = false;
    const service = createAfterHoursLinesService({
      isEnabled: async () => false,
      store: {
        findForChannel: async () => {
          read = true;
          return [];
        },
      },
      isRestrictedChannel: async () => false,
    });
    await expect(service.forChannel(ORG, CH, ["m1"])).rejects.toMatchObject({ statusCode: 404 });
    expect(read).toBe(false);
  });

  it("lineStateOf: a restricted channel withholds every row, an unanswered one included", () => {
    expect(lineStateOf(null, true)).toBe("withheld");
    expect(lineStateOf(null, false)).toBe("not_confirmed");
  });
});

describe("the outcome consumer (S3/S4)", () => {
  const event = (payload: unknown): DispatchableOutboxEvent =>
    ({
      id: "00000000-0000-4000-8000-0000000000f1",
      organizationId: ORG,
      eventType: "m19.afterhours_triage.outcome",
      payload,
    }) as unknown as DispatchableOutboxEvent;
  const build = (result: RecordOutcomeResult = "applied") => {
    const calls: unknown[][] = [];
    const warns: string[] = [];
    const consumer = buildM36AfterHoursOutcomeConsumer({
      store: {
        recordOutcome: async (...args) => {
          calls.push(args);
          return result;
        },
      },
      warn: (m) => warns.push(m),
    });
    return { consumer, calls, warns };
  };

  it("records the outcome from the ENVELOPE org and the payload ids", async () => {
    const { consumer, calls } = build();
    await consumer.handle(
      event({ sourceOutboxEventId: EVT, triageCallId: CALL, outcome: "opened" }),
    );
    expect(calls).toEqual([[ORG, EVT, "opened", CALL]]);
    expect(consumer.eventTypes).toEqual(["m19.afterhours_triage.outcome"]);
  });

  it("no_coverage carries no call id", async () => {
    const { consumer, calls } = build();
    await consumer.handle(
      event({ sourceOutboxEventId: EVT, triageCallId: null, outcome: "no_coverage" }),
    );
    expect(calls).toEqual([[ORG, EVT, "no_coverage", null]]);
  });

  it("a redelivery converges (no throw)", async () => {
    const { consumer } = build("converged");
    await expect(
      consumer.handle(event({ sourceOutboxEventId: EVT, triageCallId: CALL, outcome: "opened" })),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["not an object", null],
    ["a non-uuid source id", { sourceOutboxEventId: "x", triageCallId: CALL, outcome: "opened" }],
    ["an unknown outcome", { sourceOutboxEventId: EVT, triageCallId: CALL, outcome: "closed" }],
    ["opened with no call", { sourceOutboxEventId: EVT, triageCallId: null, outcome: "opened" }],
    [
      "no_coverage with a call",
      { sourceOutboxEventId: EVT, triageCallId: CALL, outcome: "no_coverage" },
    ],
  ])("throws (so the outbox dead-letters it) on %s, and writes nothing", async (_n, payload) => {
    const { consumer, calls, warns } = build();
    await expect(consumer.handle(event(payload))).rejects.toThrow(/malformed/);
    expect(calls).toEqual([]);
    expect(warns).toHaveLength(1);
  });

  it.each(["unknown", "conflict"] as const)(
    "throws on %s so it is never silently dropped",
    async (r) => {
      const { consumer } = build(r);
      await expect(
        consumer.handle(event({ sourceOutboxEventId: EVT, triageCallId: CALL, outcome: "opened" })),
      ).rejects.toThrow(new RegExp(r));
    },
  );
});

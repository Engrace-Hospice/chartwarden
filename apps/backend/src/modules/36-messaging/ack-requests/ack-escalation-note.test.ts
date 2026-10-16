import { describe, expect, it } from "vitest";
import { escalationNotes } from "./ack-escalation-note";
import { createMemoryAckStore } from "./ack-store-memory";
import type { AckRow } from "./ack-types";

const ORG = "00000000-0000-4000-8000-00000000000a";
const T0 = new Date("2026-10-15T12:00:00.000Z");
const row = (n: number, over: Partial<AckRow> = {}): AckRow =>
  ({
    id: `00000000-0000-4000-8000-00000000010${n}`,
    organizationId: ORG,
    status: "pending",
    windowStartedAt: T0,
    deadlineAt: new Date(T0.getTime() + 15 * 60_000),
    ...over,
  }) as AckRow;

describe("escalationNotes", () => {
  it("reads the whole list with ONE batched query and notes only overdue waiting requests with a record in the current window", async () => {
    const store = createMemoryAckStore();
    const rows = [
      row(1),
      row(2),
      row(3, { status: "acknowledged" }),
      row(4, { deadlineAt: new Date(T0.getTime() + 9e9) }),
    ];
    for (const r of rows) store.requests.set(r.id, r);
    const base = {
      organizationId: ORG,
      actorUserId: null,
      fromStatus: "pending" as const,
      toStatus: "pending" as const,
      assignedUserId: null,
      previousAssignedUserId: null,
      tier: 1,
    };
    const tx = store.bind({}, ORG);
    await tx.insertEvent({
      ...base,
      requestId: rows[0]!.id,
      eventType: "route_unavailable",
      at: new Date(T0.getTime() + 20 * 60_000),
    });
    await tx.insertEvent({
      ...base,
      requestId: rows[0]!.id,
      eventType: "ladder_exhausted",
      at: new Date(T0.getTime() + 90 * 60_000),
    });
    await tx.insertEvent({
      ...base,
      requestId: rows[2]!.id,
      eventType: "route_unavailable",
      at: new Date(T0.getTime() + 20 * 60_000),
    });
    // A record from BEFORE the current window is history, not today's state.
    await tx.insertEvent({
      ...base,
      requestId: rows[1]!.id,
      eventType: "route_unavailable",
      at: new Date(T0.getTime() - 60_000),
    });
    let calls = 0;
    const counting = {
      ...tx,
      unroutedSummary: (r: Parameters<typeof tx.unroutedSummary>[0]) => {
        calls += 1;
        return tx.unroutedSummary(r);
      },
    };

    const notes = await escalationNotes(counting, rows, new Date(T0.getTime() + 2 * 3_600_000));

    expect(calls).toBe(1);
    expect([...notes]).toEqual([[rows[0]!.id, "ladder_exhausted"]]);
  });
});

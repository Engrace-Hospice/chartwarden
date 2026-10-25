// #749 - the ack cursor is persisted per (org, provider entity, usage, vendor, stage) and advances only after a page
// was durably handed to `onPage`. No database: the store is an in-memory CAS fake (the real one has a live suite).
import {
  CH,
  type ClearinghouseBinding,
  type ClearinghouseContext,
} from "@chartwarden/x12-837-client";
import { InMemoryClearinghouse } from "@chartwarden/x12-837-client/testing";
import { describe, expect, it } from "vitest";
import {
  type AckCursorKey,
  type AckCursorStore,
  type M23TransportDeps,
  MAX_ACK_PAGES_PER_TICK,
  type TransportAck,
  pullTransportAcks,
  transportUpload,
} from "../src/modules/23-billing-medicare/jobs/clearinghouse-submission";

const ORG = "11111111-1111-1111-1111-111111111111";
const PE = "22222222-2222-2222-2222-222222222222";
const PE2 = "33333333-3333-3333-3333-333333333333";
const ctxFor = (pe: string): ClearinghouseContext => ({
  organizationId: ORG,
  providerEntityId: pe,
  payerId: "ngs_j6",
  correlationId: "corr",
  usage: "test",
  jurisdiction: "ngs_j6",
});
const ISA =
  "ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260101*1200*^*00501*000000001*0*T*:~";

const keyOf = (k: AckCursorKey) =>
  [k.organizationId, k.providerEntityId, k.usage, k.vendor, k.kind].join("|");

/** CAS fake with the same contract as the Drizzle store. */
function fakeStore() {
  const rows = new Map<string, { cursor: string | null; version: number }>();
  const store: AckCursorStore = {
    async read(k) {
      return rows.get(keyOf(k)) ?? { cursor: null, version: 0 };
    },
    async advance(k, expectedVersion, next) {
      const cur = rows.get(keyOf(k)) ?? { cursor: null, version: 0 };
      if (cur.version !== expectedVersion) return false;
      rows.set(keyOf(k), { cursor: next, version: cur.version + 1 });
      return true;
    },
  };
  return { store, rows };
}

async function seed(
  inMemory: InMemoryClearinghouse,
  t: M23TransportDeps,
  pe: string,
  n: number,
  prefix = "C",
) {
  for (let i = 0; i < n; i++) {
    const controlNumber = `${prefix}${i}`;
    await transportUpload(t)({
      organizationId: ORG,
      providerEntityId: pe,
      kind: "claim_837i",
      x12: ISA,
      controlNumber,
    });
    await inMemory.control.clearinghouseAccepts(controlNumber, {
      organizationId: ORG,
      providerEntityId: pe,
      usage: "test",
    });
  }
}

function setup(entities: readonly string[] = [PE]) {
  const inMemory = new InMemoryClearinghouse();
  const { store, rows } = fakeStore();
  const binding: ClearinghouseBinding = {
    vendor: "in_memory",
    transport: inMemory,
  };
  const t: M23TransportDeps = {
    binding,
    ackCursors: store,
    contexts: {
      contextFor: async (_o, pe) => ctxFor(pe),
      providerEntitiesFor: async () => entities,
    },
  };
  return { inMemory, t, store, rows };
}

const collect = () => {
  const pages: TransportAck[][] = [];
  return {
    pages,
    onPage: async (acks: readonly TransportAck[]) => {
      pages.push([...acks]);
    },
  };
};

describe("pullTransportAcks with a persisted cursor (#749)", () => {
  it("reads past the old 100-page cap and resumes from the stored cursor on the next tick", async () => {
    const { inMemory, t, rows } = setup();
    await seed(inMemory, t, PE, 5); // in-memory page size is 2 -> 3 pages
    const first = collect();
    expect((await pullTransportAcks(t, ORG, "ack_999", first.onPage)).failures).toEqual([]);
    expect(first.pages.flat()).toHaveLength(5);
    expect([...rows.values()][0]?.cursor).toBe("5");
    const second = collect();
    await pullTransportAcks(t, ORG, "ack_999", second.onPage);
    expect(second.pages.flat()).toHaveLength(0);
    await seed(inMemory, t, PE, 1, "LATE");
    const third = collect();
    await pullTransportAcks(t, ORG, "ack_999", third.onPage);
    expect(third.pages.flat().map((a) => a.controlNumber)).toEqual(["LATE0"]);
  });

  it("does not advance past a page whose handler threw; the next tick replays that page", async () => {
    const { inMemory, t, rows } = setup();
    await seed(inMemory, t, PE, 5);
    let calls = 0;
    const pulled = await pullTransportAcks(t, ORG, "ack_999", async () => {
      calls += 1;
      if (calls === 2) throw new Error("apply failed");
    });
    expect(pulled.failures).toEqual([expect.stringContaining("apply failed")]);
    expect([...rows.values()][0]?.cursor).toBe("2"); // only page 1 is durable
    const retry = collect();
    await pullTransportAcks(t, ORG, "ack_999", retry.onPage);
    expect(retry.pages.flat()).toHaveLength(3);
  });

  it("keeps a separate cursor per stage, so the 277CA cron still sees what the 999 cron consumed", async () => {
    const { inMemory, t } = setup();
    await seed(inMemory, t, PE, 1);
    await inMemory.control.payerAccepts("C0", "ICN", {
      organizationId: ORG,
      providerEntityId: PE,
      usage: "test",
    });
    const a = collect();
    await pullTransportAcks(t, ORG, "ack_999", a.onPage);
    const b = collect();
    await pullTransportAcks(t, ORG, "ack_277ca", b.onPage);
    expect(a.pages.flat().map((x) => x.kind)).toEqual(["ack_999"]);
    expect(b.pages.flat().map((x) => x.kind)).toEqual(["ack_277ca"]);
  });

  it("isolates provider entities: one entity's failure leaves the other's cursor advancing", async () => {
    const { inMemory, t, rows } = setup([PE, PE2]);
    await seed(inMemory, t, PE, 2);
    await seed(inMemory, t, PE2, 2, "D");
    const pulled = await pullTransportAcks(t, ORG, "ack_999", async (acks) => {
      if (acks.some((a) => a.providerEntityId === PE)) throw new Error("boom");
    });
    expect(pulled.failures).toHaveLength(1);
    const byEntity = Object.fromEntries([...rows].map(([k, v]) => [k.split("|")[1], v.cursor]));
    expect(byEntity[PE2]).toBe("2");
    expect(byEntity[PE]).toBeUndefined();
  });

  it("falls back to a null re-read when the vendor refuses the stored cursor, and re-stores a good one", async () => {
    const { inMemory, t, rows } = setup();
    await seed(inMemory, t, PE, 3);
    const key = [ORG, PE, "test", "in_memory", "ack_999"].join("|");
    rows.set(key, { cursor: "9999", version: 4 }); // beyond the end -> CH_INVALID_REQUEST
    const c = collect();
    const pulled = await pullTransportAcks(t, ORG, "ack_999", c.onPage);
    expect(pulled.failures).toEqual([]);
    expect(c.pages.flat()).toHaveLength(3);
    expect(rows.get(key)?.cursor).toBe("3");
  });

  it("a degraded answer for a null cursor is still a failure (no reset loop)", async () => {
    const { inMemory, t } = setup();
    await inMemory.control.setOutage(true);
    const pulled = await pullTransportAcks(t, ORG, "ack_999", async () => {});
    expect(pulled.failures).toEqual([expect.stringContaining(CH.UNAVAILABLE)]);
  });

  it("a concurrent tick that lost the compare-and-set stops without regressing the cursor", async () => {
    const { inMemory, t, store, rows } = setup();
    await seed(inMemory, t, PE, 4);
    const key: AckCursorKey = {
      organizationId: ORG,
      providerEntityId: PE,
      usage: "test",
      vendor: "in_memory",
      kind: "ack_999",
    };
    // the rival tick advances to "4" while this tick is still handling its first page
    const pulled = await pullTransportAcks(t, ORG, "ack_999", async () => {
      const cur = await store.read(key);
      if (cur.version === 0) await store.advance(key, 0, "4");
    });
    expect(pulled.failures).toEqual([]);
    expect(rows.get(keyOf(key))?.cursor).toBe("4");
  });

  it("without a store it still pages to the end every tick (null cursor, no cap)", async () => {
    const { inMemory, t } = setup();
    await seed(inMemory, t, PE, 5);
    const c = collect();
    await pullTransportAcks({ ...t, ackCursors: undefined }, ORG, "ack_999", c.onPage);
    expect(c.pages.flat()).toHaveLength(5);
  });

  it("refuses a vendor that reports more pages but never moves the cursor", async () => {
    const { t } = setup();
    const stuck: M23TransportDeps = {
      ...t,
      binding: {
        vendor: "in_memory",
        transport: {
          fetchAcknowledgments: async (_c: unknown, cursor: string | null) => ({
            ok: true,
            data: { items: [], nextCursor: cursor ?? "0", hasMore: true },
          }),
        } as never,
      },
    };
    const pulled = await pullTransportAcks(stuck, ORG, "ack_999", async () => {});
    expect(pulled.failures).toEqual([expect.stringContaining("did not advance")]);
  });

  it("fails on a vendor cursor that cycles A -> B -> A, keeping the cursor at the last applied page", async () => {
    const { t, rows } = setup();
    const chain = ["A", "B", "A"];
    let n = 0;
    const cycling: M23TransportDeps = {
      ...t,
      binding: {
        vendor: "in_memory",
        transport: {
          fetchAcknowledgments: async () => ({
            ok: true,
            data: {
              items: [],
              nextCursor: chain[n++ % chain.length],
              hasMore: true,
            },
          }),
        } as never,
      },
    };
    const pulled = await pullTransportAcks(cycling, ORG, "ack_999", async () => {});
    expect(pulled.failures).toEqual([expect.stringContaining("repeated position")]);
    expect([...rows.values()][0]?.cursor).toBe("B"); // pages A and B were applied; the repeat was refused
  });

  it("stops at the per-tick page cap, reports a backlog, and the next tick resumes from the stored cursor", async () => {
    const { inMemory, t, rows } = setup();
    const total = MAX_ACK_PAGES_PER_TICK * 2 + 3; // in-memory pages hold 2 events
    await seed(inMemory, t, PE, total);
    const first = collect();
    const tick1 = await pullTransportAcks(t, ORG, "ack_999", first.onPage);
    expect(tick1.failures).toEqual([]);
    expect(tick1.backlog).toHaveLength(1);
    expect(first.pages.flat()).toHaveLength(MAX_ACK_PAGES_PER_TICK * 2);
    expect([...rows.values()][0]?.cursor).toBe(String(MAX_ACK_PAGES_PER_TICK * 2));
    const second = collect();
    const tick2 = await pullTransportAcks(t, ORG, "ack_999", second.onPage);
    expect(tick2.backlog).toEqual([]);
    expect(second.pages.flat().map((a) => a.controlNumber)).toEqual(["C100", "C101", "C102"]);
    expect([...rows.values()][0]?.cursor).toBe(String(total));
  });

  it("rejects an unusable cursor length before anything is applied", async () => {
    const { t } = setup();
    const bad: M23TransportDeps = {
      ...t,
      binding: {
        vendor: "in_memory",
        transport: {
          fetchAcknowledgments: async () => ({
            ok: true,
            data: { items: [], nextCursor: "x".repeat(513), hasMore: false },
          }),
        } as never,
      },
    };
    const pulled = await pullTransportAcks(bad, ORG, "ack_999", async () => {});
    expect(pulled.failures).toEqual([expect.stringContaining("unusable length")]);
  });

  it("quarantines an unroutable event (clearinghouse-stage partial) instead of stalling the stream behind it", async () => {
    const { t, rows } = setup();
    const ev = (eventId: string, stage: string, disposition: string) => ({
      eventId,
      stage,
      disposition,
      controlNumber: `CN-${eventId}`,
      reasonCodes: [],
      occurredAt: "2026-10-11",
    });
    const items = [
      ev("e1", "clearinghouse", "accepted"),
      ev("e2", "clearinghouse", "partial"),
      ev("e3", "clearinghouse", "accepted"),
    ];
    const bad: M23TransportDeps = {
      ...t,
      binding: {
        vendor: "in_memory",
        transport: {
          fetchAcknowledgments: async () => ({
            ok: true,
            data: { items, nextCursor: "3", hasMore: false },
          }),
        } as never,
      },
    };
    const c = collect();
    const pulled = await pullTransportAcks(bad, ORG, "ack_999", c.onPage);
    expect(pulled.failures).toEqual([]);
    expect(c.pages.flat().map((a) => a.controlNumber)).toEqual(["CN-e1", "CN-e3"]);
    expect(pulled.quarantined).toEqual([
      expect.objectContaining({
        eventId: "e2",
        controlNumber: "CN-e2",
        reason: expect.stringContaining("payer-stage only"),
      }),
    ]);
    expect([...rows.values()][0]?.cursor).toBe("3"); // the cursor moved past it
    // the 277CA cron reads the same stream but does not double-report
    const other = await pullTransportAcks(bad, ORG, "ack_277ca", async () => {});
    expect(other.quarantined).toEqual([]);
  });
});

// apps/backend/__tests__/document-backref-consumers.test.ts — the §7.2 W2 handshake's DOWNSTREAM half:
// M22 announcing `m22.document.rendered`, and the four requesting modules stamping their own back-ref
// column from it. The happy path is proven over real Postgres in
// ./gap-023-024-038-render-handshake.live.test.ts; what is here is the part a live test cannot show
// cheaply — every OFF-path, where the correct behaviour is to write nothing at all.
//
// Why that matters more than usual: these consumers all subscribe to the SAME event. The dispatcher hands
// every rendered document to all four, so "ignore what is not mine" is not defensive coding, it is the
// entire routing mechanism. A consumer that stamped on a document another module requested would write a
// foreign document id onto a clinical row, silently, with every gate green.
import { describe, expect, it } from "vitest";
import { buildM11DocumentBackrefConsumer } from "../src/modules/11-orders/index";
import { buildM12DocumentBackrefConsumer } from "../src/modules/12-dosespot/index";
import { buildM13DocumentBackrefConsumer } from "../src/modules/13-emar/index";
import { buildM21DocumentBackrefConsumer } from "../src/modules/21-supplies/index";
import {
  M22_DOCUMENT_RENDERED_EVENT,
  M22_OUTBOX_EVENTS,
  buildM22DocumentRequestConsumer,
  createDocumentRenderer,
  createInMemoryDocumentSeamStore,
  createInMemoryObjectStore,
} from "../src/modules/22-documents/index";
import { buildM33DocumentBackrefConsumer } from "../src/modules/33-reporting/index";

const ORG = "00000000-0000-4000-8000-0000000000ee";
const PAT = "00000000-0000-4000-8000-0000000000aa";
const ORDER = "00000000-0000-4000-8000-0000000000bb";

/** A `db` that fails loudly if a consumer opens a transaction it should never have opened. */
const NEVER_DB = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`the consumer touched the database (.${String(prop)}) on an off-path`);
    },
  },
) as never;

const rendered = (over: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  payload: {
    documentId: "00000000-0000-4000-8000-0000000000d0",
    aggregateType: "order_record",
    aggregateId: ORDER,
    sourceModule: "m11",
    sourceEvent: "m11.order.document_requested",
    ...over,
  },
});

// ── the announcement ────────────────────────────────────────────────────────────────────────────────────

describe("m22.document.rendered — the event that did not exist", () => {
  it("declares exactly the consumers that are bound, not the ones that are interested", () => {
    const entry = M22_OUTBOX_EVENTS.find((e) => e.eventName === M22_DOCUMENT_RENDERED_EVENT);
    expect(entry).toBeDefined();
    // M14/M23/M25/M27/M39 all NAME this event in their subscription maps. Listing them here without a
    // live binding would hold every render's back-ref row `pending` forever — the dispatcher's staged-
    // deployment rule — so each is added on the commit that binds its handler. (M33 arrived on GAP-051's.)
    // It cuts both ways: the dispatcher THROWS at construction on a module that binds an event it is not
    // declared for, so this list and the bound set move together or boot fails.
    expect(entry?.declaredConsumers).toEqual(["m11", "m12", "m13", "m21", "m33"]);
  });

  it("announces the render with the routing the requesting module keys on", async () => {
    const { store } = createInMemoryDocumentSeamStore();
    const objects = createInMemoryObjectStore();
    const announced: Record<string, unknown>[] = [];
    const consumer = buildM22DocumentRequestConsumer({
      store,
      renderer: () => createDocumentRenderer({ store, objects: objects.store }),
      emitRendered: async (e) => {
        announced.push(e as unknown as Record<string, unknown>);
      },
    });
    const delivery = {
      id: "e1",
      organizationId: ORG,
      eventType: "m11.order.document_requested",
      aggregateKind: "order",
      aggregateId: ORDER,
      payload: {
        orderId: ORDER,
        formTemplate: "order_record",
        renderPayload: { patientId: PAT },
      },
      attemptCount: 0,
      createdAt: new Date("2026-08-13T00:00:00.000Z"),
    };
    await consumer.handle(delivery);

    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({
      organizationId: ORG,
      aggregateType: "order_record",
      aggregateId: ORDER,
      patientId: PAT,
      templateKey: "order_record",
      sourceEvent: "m11.order.document_requested",
      sourceModule: "m11", // derived from the event name's own namespace
      isFirstVersion: true,
      versionNumber: 1,
    });

    // THE CRASH CASE. The render and the announcement are separate transactions (the renderer opens its
    // own), so a crash between them is redelivered — and the redelivery finds the document already
    // rendered. If that path returned silently, the back-ref would be lost permanently, only under a
    // crash, with no trace. It must re-announce instead.
    await consumer.handle(delivery);
    expect(announced).toHaveLength(2);
    expect(announced[1]).toMatchObject({
      documentId: announced[0]?.documentId,
      aggregateId: ORDER,
    });
  });
});

// ── the four stampers, on every off-path ────────────────────────────────────────────────────────────────

describe("the back-ref consumers ignore every document they did not request", () => {
  const cases = [
    { name: "M11", build: buildM11DocumentBackrefConsumer, module: "m11", type: "order_record" },
    {
      name: "M12",
      build: buildM12DocumentBackrefConsumer,
      module: "m12",
      type: "medication_order",
    },
    {
      name: "M13",
      build: buildM13DocumentBackrefConsumer,
      module: "m13",
      type: "medication_reconciliation_worksheet",
    },
    {
      name: "M21",
      build: buildM21DocumentBackrefConsumer,
      module: "m21",
      type: "supply_bill_of_lading",
    },
  ] as const;

  for (const c of cases) {
    describe(c.name, () => {
      const consumer = c.build({ db: NEVER_DB });

      it("subscribes to m22.document.rendered under its own module", () => {
        expect(consumer.eventTypes).toEqual([M22_DOCUMENT_RENDERED_EVENT]);
        expect(consumer.consumerModule).toBe(c.module);
      });

      it("does nothing for a document another module requested", async () => {
        await expect(
          consumer.handle(rendered({ sourceModule: "m6", aggregateType: c.type })),
        ).resolves.toBeUndefined();
      });

      it("does nothing for an aggregate type that is not its own", async () => {
        await expect(
          consumer.handle(
            rendered({ sourceModule: c.module, aggregateType: "bereavement_letter" }),
          ),
        ).resolves.toBeUndefined();
      });

      it("does nothing when the payload is missing the ids", async () => {
        await expect(
          consumer.handle(
            rendered({ sourceModule: c.module, aggregateType: c.type, documentId: null }),
          ),
        ).resolves.toBeUndefined();
        await expect(
          consumer.handle(
            rendered({ sourceModule: c.module, aggregateType: c.type, aggregateId: undefined }),
          ),
        ).resolves.toBeUndefined();
      });
    });
  }

  // M21 is the only one whose ONE consumer serves TWO tables — the routing that decides whether a
  // document lands on the dispatch row or the return row.
  it("M21 ignores an M21 document whose aggregate type maps to neither of its two tables", async () => {
    const consumer = buildM21DocumentBackrefConsumer({ db: NEVER_DB });
    await expect(
      consumer.handle(rendered({ sourceModule: "m21", aggregateType: "comfort_kit_receipt" })),
    ).resolves.toBeUndefined();
  });
});

// ── M33's back-ref consumer (GAP-051) ───────────────────────────────────────────────────────────────────
//
// M33's is not a column stamp: a rendered scheduled report SETTLES its occurrence `delivered` and emits the
// §4.9 fan-out, so it composes the package's decider/applier. Its routing also differs from the four above —
// it keys on `aggregateType` alone, because M33 owns TWO document aggregate types and only one of them has a
// row to settle.
describe("M33's delivery consumer", () => {
  const consumer = buildM33DocumentBackrefConsumer({ db: NEVER_DB });

  it("subscribes to m22.document.rendered as m33", () => {
    expect(consumer.eventTypes).toEqual([M22_DOCUMENT_RENDERED_EVENT]);
    expect(consumer.consumerModule).toBe("m33");
  });

  it("does nothing for another module's rendered document", async () => {
    await expect(
      consumer.handle(rendered({ sourceModule: "m11", aggregateType: "order_record" })),
    ).resolves.toBeUndefined();
  });

  it("does nothing for M33's OTHER artifact — the ad-hoc export has no row to settle", async () => {
    // `report_export` is reachable by `document.(aggregate_type, aggregate_id)` alone; there is no
    // `report_export` table, so touching the database here would be a bug, not a stamp.
    await expect(
      consumer.handle(rendered({ sourceModule: "m33", aggregateType: "report_export" })),
    ).resolves.toBeUndefined();
  });

  it("does nothing when the reply is missing the run or document id", async () => {
    for (const missing of [{ documentId: null }, { aggregateId: undefined }]) {
      await expect(
        consumer.handle(
          rendered({ sourceModule: "m33", aggregateType: "report_schedule_run", ...missing }),
        ),
      ).resolves.toBeUndefined();
    }
  });
});

// apps/backend/__tests__/document-render-consumer.test.ts — GAP-023/024/038. The LIVE §4.11 render-handshake
// consumer: the payload normalizer (each source module's own wire shape → M22's canonical request) and the
// consumer's execution of every {@link decideDocumentRequest} outcome. No DB — the seam store and the
// renderer are the in-memory slices; the live end-to-end proof over real Postgres + the real dispatcher is
// ./gap-023-024-038-render-handshake.live.test.ts.
import { beforeEach, describe, expect, it } from "vitest";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { M21_OUTBOX_EVENTS } from "../src/modules/21-supplies/index";
import {
  M22_DOCUMENT_REQUEST_EVENTS,
  MalformedRenderRequestError,
  buildM22DocumentRequestConsumer,
  createDocumentRenderer,
  createInMemoryDocumentSeamStore,
  createInMemoryObjectStore,
  normalizeDocumentRequest,
} from "../src/modules/22-documents/index";
import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/index";

const ORG = "00000000-0000-4000-8000-0000000000ee";
const PAT = "00000000-0000-4000-8000-0000000000aa";
const ORDER = "00000000-0000-4000-8000-0000000000bb";
const ADMISSION = "00000000-0000-4000-8000-0000000000cc";
const SUPPLY_REQUEST = "00000000-0000-4000-8000-0000000000d1";
const DISPATCH = "00000000-0000-4000-8000-0000000000d2";
const RETURN = "00000000-0000-4000-8000-0000000000d3";

function delivered(over: Partial<DispatchableOutboxEvent> = {}): DispatchableOutboxEvent {
  return {
    id: "00000000-0000-4000-8000-00000000000e",
    organizationId: ORG,
    eventType: "m11.order.document_requested",
    aggregateKind: "order",
    aggregateId: ORDER,
    payload: {
      orderId: ORDER,
      formTemplate: "order_record",
      renderPayload: { patientId: PAT, kind: "lab" },
    },
    attemptCount: 0,
    createdAt: new Date("2026-08-13T00:00:00.000Z"),
    ...over,
  };
}

/** The consumer over in-memory ports, plus handles on what it produced. */
function harness(
  opts: { templates?: Parameters<typeof createDocumentRenderer>[0]["templates"] } = {},
) {
  const { store } = createInMemoryDocumentSeamStore();
  const objects = createInMemoryObjectStore();
  const renderer = createDocumentRenderer({
    store,
    objects: objects.store,
    ...(opts.templates ? { templates: opts.templates } : {}),
  });
  const rendered: { templateKey: string; payload: unknown }[] = [];
  const refusals: { kind: string; detail: string }[] = [];
  const consumer = buildM22DocumentRequestConsumer({
    store,
    renderer: () => ({
      render: async (scope, templateKey, payload) => {
        rendered.push({ templateKey, payload });
        return renderer.render(scope, templateKey, payload);
      },
    }),
    onRefusal: (r) => refusals.push({ kind: r.kind, detail: r.detail }),
    ...(opts.templates ? { templates: opts.templates } : {}),
  });
  return { consumer, store, objects, rendered, refusals };
}

// ── the per-event payload normalizer (pure) ─────────────────────────────────────────────────────────────

describe("GAP-023/024/038 — normalizeDocumentRequest adapts each source module's own wire shape", () => {
  it("reads M11's {orderId, formTemplate, renderPayload} — patientId from inside renderPayload", () => {
    const { event, payload } = normalizeDocumentRequest({
      eventType: "m11.order.document_requested",
      organizationId: ORG,
      payload: {
        orderId: ORDER,
        formTemplate: "order_record",
        renderPayload: { patientId: PAT, kind: "lab" },
      },
    });
    expect(event).toBe("m11.order.document_requested");
    expect(payload).toEqual({
      organizationId: ORG,
      templateKey: "order_record",
      aggregateId: ORDER,
      patientId: PAT,
      content: { patientId: PAT, kind: "lab" },
    });
  });

  it("reads M12's identical shape", () => {
    const { payload } = normalizeDocumentRequest({
      eventType: "m12.medication_order.document_requested",
      organizationId: ORG,
      payload: {
        orderId: ORDER,
        formTemplate: "medication_order",
        renderPayload: { patientId: PAT },
      },
    });
    expect(payload.templateKey).toBe("medication_order");
    expect(payload.aggregateId).toBe(ORDER);
  });

  // M13's `formTemplate` is M13's OWN form name, not an M22 published key — the shape table fixes the key.
  it("maps M13's reconciliation_worksheet_v1 onto M22's published template key", () => {
    const { payload } = normalizeDocumentRequest({
      eventType: "m13.reconciliation.document_requested",
      organizationId: ORG,
      payload: {
        worksheetId: ORDER,
        formTemplate: "reconciliation_worksheet_v1",
        renderPayload: { patientId: PAT },
      },
    });
    expect(payload.templateKey).toBe("medication_reconciliation_worksheet");
    expect(payload.aggregateId).toBe(ORDER);
  });

  // GAP-038 — the ABN is a flat financial record with no formTemplate field at all; the whole payload is
  // the render content and the event name alone names the artifact.
  it("maps M23's flat ABN record onto the abn template, whole payload as content", () => {
    const abn = {
      abnId: ORDER,
      patientId: PAT,
      organizationId: "00000000-0000-4000-8000-000000000fff", // caller-asserted — must be IGNORED
      claimId: null,
      serviceDescription: "Continuous home care, 8h",
      estimatedCost: 124_50,
      reasonNoncovered: "not related to terminal diagnosis",
      requiredBy: "2026-09-01T00:00:00.000Z",
    };
    const { payload } = normalizeDocumentRequest({
      eventType: "m23.abn.required",
      organizationId: ORG,
      payload: abn,
    });
    expect(payload.templateKey).toBe("abn");
    expect(payload.aggregateId).toBe(ORDER);
    expect(payload.patientId).toBe(PAT);
    expect(payload.content).toEqual(abn);
    // The tenant anchor is the OUTBOX ROW's org (RLS-scoped, dispatcher-verified), never the body's.
    expect(payload.organizationId).toBe(ORG);
  });

  // M21 — ONE event, TWO artifacts, and the identity is on the ENVELOPE. Both bodies carry `dispatchId`;
  // only the outbox row distinguishes the dispatch (BOL) from the return (receipt), so reading the body
  // would file the return receipt against the dispatch.
  it("routes M21's documentKind discriminator to the right template, keyed off the envelope id", () => {
    const bol = normalizeDocumentRequest({
      eventType: "m21.supply_request.document_requested",
      organizationId: ORG,
      aggregateId: DISPATCH,
      payload: {
        orgId: ORG,
        patientId: PAT,
        admissionId: ADMISSION,
        supplyRequestId: SUPPLY_REQUEST,
        dispatchId: DISPATCH,
        documentKind: "bill_of_lading",
        requestedAt: "2026-08-13T00:00:00.000Z",
      },
    });
    expect(bol.payload.templateKey).toBe("supply_bill_of_lading");
    expect(bol.payload.aggregateId).toBe(DISPATCH);
    expect(bol.payload.patientId).toBe(PAT);

    const receipt = normalizeDocumentRequest({
      eventType: "m21.supply_request.document_requested",
      organizationId: ORG,
      aggregateId: RETURN, // the RETURN row, not the dispatchId the body still carries
      payload: {
        orgId: ORG,
        patientId: PAT,
        admissionId: ADMISSION,
        supplyRequestId: SUPPLY_REQUEST,
        dispatchId: DISPATCH,
        documentKind: "return_receipt",
        requestedAt: "2026-08-13T00:00:00.000Z",
      },
    });
    expect(receipt.payload.templateKey).toBe("comfort_kit_return_receipt");
    expect(receipt.payload.aggregateId).toBe(RETURN);
  });

  // A guess here would file the wrong document under a real patient's chart; a dead letter would not.
  it("throws on a documentKind M22 has no template for, rather than guessing", () => {
    expect(() =>
      normalizeDocumentRequest({
        eventType: "m21.supply_request.document_requested",
        organizationId: ORG,
        aggregateId: DISPATCH,
        payload: { dispatchId: DISPATCH, documentKind: "packing_list" },
      }),
    ).toThrow(/packing_list' maps to no M22 template/);
  });

  it("throws on an event that is not a §4.11 render request", () => {
    expect(() =>
      normalizeDocumentRequest({
        eventType: "m11.order.signed",
        organizationId: ORG,
        payload: { orderId: ORDER },
      }),
    ).toThrow(MalformedRenderRequestError);
  });

  it("throws when the payload names no aggregate id or no template", () => {
    expect(() =>
      normalizeDocumentRequest({
        eventType: "m11.order.document_requested",
        organizationId: ORG,
        payload: { formTemplate: "order_record" },
      }),
    ).toThrow(/names no aggregate id/);
    expect(() =>
      normalizeDocumentRequest({
        eventType: "m11.order.document_requested",
        organizationId: ORG,
        payload: { orderId: ORDER },
      }),
    ).toThrow(/names no template/);
  });
});

// ── the live consumer's execution of each decided outcome ───────────────────────────────────────────────

describe("GAP-023/024/038 — the render consumer executes the decided action", () => {
  beforeEach(() => __resetSeamsForTest());

  it("renders a signed order's PDF and files it against the patient's chart", async () => {
    const h = harness();
    await h.consumer.handle(delivered());

    expect(h.rendered).toHaveLength(1);
    expect(h.rendered[0]?.templateKey).toBe("order_record");
    expect(h.rendered[0]?.payload).toMatchObject({
      aggregateId: ORDER,
      patientId: PAT,
      kind: "lab",
    });
    // The `document` row the render produced IS the back-ref: (aggregate_type, aggregate_id).
    const doc = await h.store.renderedDocumentForAggregate({
      aggregateType: "order_record",
      aggregateId: ORDER,
      organizationId: ORG,
    });
    expect(doc).not.toBeNull();
  });

  it("subscribes to the events M11/M12/M13/M23 declare — and nothing else", () => {
    expect(harness().consumer.eventTypes).toEqual([
      "m11.order.document_requested",
      "m12.medication_order.document_requested",
      "m13.reconciliation.document_requested",
      "m21.supply_request.document_requested",
      "m23.abn.required",
    ]);
  });

  // The load-bearing one. `createOutboxDispatcher` THROWS at construction on a consumer that binds an
  // event type absent from the boot catalog ("binds unknown catalog event") — so a phantom name here is
  // not a dead subscription, it is a crashed boot. The pre-fix list carried five of them
  // (`m6.document_requested`, `m9.…`, `m14.…`, `m16.…`, `m23.abn.document_requested`); they were only
  // survivable because nothing was ever bound. This pins each subscribed name to a real producer
  // declaration that names m22 as a consumer, so a producer-side rename fails here rather than at boot.
  it("every subscribed event is declared by its producer, with m22 among its consumers", () => {
    const declared = new Map(
      [
        ...M11_OUTBOX_EVENTS,
        ...M12_OUTBOX_EVENTS,
        ...M13_OUTBOX_EVENTS,
        ...M21_OUTBOX_EVENTS,
        ...M23_OUTBOX_EVENTS,
      ].map((e) => [e.eventName, e]),
    );
    for (const eventName of M22_DOCUMENT_REQUEST_EVENTS) {
      const entry = declared.get(eventName);
      expect(entry, `${eventName} is not declared by any producer catalog`).toBeDefined();
      expect(entry?.declaredConsumers).toContain("m22");
    }
  });

  // D14 — the dispatcher redelivers on any post-render crash; the rendered row is the durable dedup key.
  it("does not double-render on re-delivery of the same request", async () => {
    const h = harness();
    await h.consumer.handle(delivered());
    await h.consumer.handle(delivered());
    expect(h.rendered).toHaveLength(1);
  });

  // §7.2 — a template that has not been published YET may be published in a minute; the request must
  // survive until then, so this is a throw (retry → DLQ), not a silent completion.
  it("throws (retry-then-DLQ) on an unpublished template key, rendering nothing", async () => {
    const h = harness();
    await expect(
      h.consumer.handle(
        delivered({
          payload: { orderId: ORDER, formTemplate: "no_such_template", renderPayload: {} },
        }),
      ),
    ).rejects.toThrow(MalformedRenderRequestError);
    expect(h.rendered).toHaveLength(0);
    expect(h.refusals).toEqual([{ kind: "unknown_template", detail: "no_such_template" }]);
  });

  // §7.16 — a settled refusal, NOT a delivery failure: retrying could never conjure a consent, and a
  // dead-lettered row would read as an outage. The row completes; the refusal is reported.
  it("refuses a SUD-class render with no active M39 consent — completes, never retries", async () => {
    registerSeam("ConsentEvaluator", { evaluate: async () => ({ allowed: false }) });
    const h = harness();
    await h.consumer.handle(
      delivered({
        payload: {
          orderId: ORDER,
          formTemplate: "order_record",
          renderPayload: { patientId: PAT, isSudClass: true },
        },
      }),
    );
    expect(h.rendered).toHaveLength(0);
    expect(h.refusals).toEqual([{ kind: "sud_consent_absent", detail: "order_record" }]);
  });

  it("renders the SUD-class request when M39 returns an active consent", async () => {
    registerSeam("ConsentEvaluator", { evaluate: async () => ({ allowed: true }) });
    const h = harness();
    await h.consumer.handle(
      delivered({
        payload: {
          orderId: ORDER,
          formTemplate: "order_record",
          renderPayload: { patientId: PAT, isSudClass: true },
        },
      }),
    );
    expect(h.rendered).toHaveLength(1);
    expect(h.rendered[0]?.payload).toMatchObject({ sudRedacted: true });
    expect(h.refusals).toHaveLength(0);
  });

  // GAP-038 end-to-end through the consumer: M23's declared event name now resolves to a real template.
  it("renders the CMS-R-131 ABN from m23.abn.required", async () => {
    const h = harness();
    await h.consumer.handle(
      delivered({
        eventType: "m23.abn.required",
        payload: {
          abnId: ORDER,
          patientId: PAT,
          serviceDescription: "Continuous home care, 8h",
          estimatedCost: 12_450,
          reasonNoncovered: "not related to terminal diagnosis",
          requiredBy: "2026-09-01T00:00:00.000Z",
        },
      }),
    );
    expect(h.rendered[0]?.templateKey).toBe("abn");
    const doc = await h.store.renderedDocumentForAggregate({
      aggregateType: "abn",
      aggregateId: ORDER,
      organizationId: ORG,
    });
    expect(doc).not.toBeNull();
  });
});

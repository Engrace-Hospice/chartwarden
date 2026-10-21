// GAP-036 - the appeal packet re-verifies its enclosures at RENDER time (a document can be superseded, destroyed or
// reclassified to 42 CFR Part 2 between submit and render), and a refusal is a settled decision, not a retry.
import { buildAppealPacketRenderPayload } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import {
  appealEnclosureIds,
  buildAppealPacketRenderGuard,
  buildM22DocumentRequestConsumer,
  createDocumentRenderer,
  createInMemoryDocumentSeamStore,
  createInMemoryObjectStore,
} from "../src/modules/22-documents/index";

const ORG = "00000000-0000-4000-8000-0000000000ee";
const APPEAL = "00000000-0000-4000-8000-0000000000bb";
const D_OK = "dddddddd-0000-4000-8000-000000000001";
const D_P2 = "dddddddd-0000-4000-8000-000000000002";
const D_GONE = "dddddddd-0000-4000-8000-000000000003";
const D_BUNDLE = "dddddddd-0000-4000-8000-000000000004";

const enclosure = (documentId: string, title: string) => ({
  documentId,
  title,
  documentDate: "2026-02-20T09:00:00.000Z",
  documentKind: "f2f",
});
const packet = (docs: string[], bundle?: string) =>
  buildAppealPacketRenderPayload({
    appealCaseId: APPEAL,
    denialCaseId: "00000000-0000-4000-8000-0000000000d1",
    claimId: "00000000-0000-4000-8000-0000000000c1",
    tier: "redetermination",
    tierDeadlineAt: "2026-12-01T00:00:00.000Z",
    submittedAt: "2026-10-08T00:00:00.000Z",
    appealNarrative: "Timely certification enclosed.",
    attachedDocuments: docs.map((d) => enclosure(d, `Doc ${d.slice(-1)}`)),
    ...(bundle ? { medicalRecordsBundle: enclosure(bundle, "Bundle") } : {}),
    claimCopy: {
      controlNumber: "CCN-1",
      tob: "811",
      state: "denied",
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-31",
      totalChargeCents: 1000,
      lines: [],
    },
    denial: { carcCode: "50", rarcCode: null, dollarValue: "10.00", remittanceLineId: null },
  });

const digestOf = (over: Record<string, unknown>) =>
  ({ patientId: "p", status: "active", retentionClass: "clinical_record", ...over }) as never;
const documents = (byId: Record<string, unknown>) => ({
  documentMetadata: vi.fn(
    async ({ documentId }: { documentId: string }) => byId[documentId] ?? null,
  ),
});

describe("appealEnclosureIds", () => {
  it("reads the supporting documents then the bundle, tolerant of a malformed payload", () => {
    expect(appealEnclosureIds(packet([D_OK, D_P2], D_BUNDLE) as never)).toEqual([
      D_OK,
      D_P2,
      D_BUNDLE,
    ]);
    expect(appealEnclosureIds({} as never)).toEqual([]);
    expect(
      appealEnclosureIds({ supportingDocuments: [null, 3, { documentId: 7 }] } as never),
    ).toEqual([]);
  });
});

describe("buildAppealPacketRenderGuard", () => {
  const guard = (byId: Record<string, unknown>) =>
    buildAppealPacketRenderGuard(() => documents(byId) as never);
  const req = (content: Record<string, unknown>, templateKey = "appeal_packet") => ({
    organizationId: ORG,
    templateKey,
    content,
  });

  it("passes a packet whose enclosures are all still enclosable", async () => {
    const g = guard({ [D_OK]: digestOf({}), [D_BUNDLE]: digestOf({ status: "legal_hold" }) });
    expect(await g(req(packet([D_OK], D_BUNDLE) as never))).toBeNull();
  });

  it("refuses when an enclosure was reclassified to 42 CFR Part 2 after submit", async () => {
    const g = guard({
      [D_OK]: digestOf({}),
      [D_P2]: digestOf({ retentionClass: "compliance_42cfr_part2" }),
    });
    expect(await g(req(packet([D_OK, D_P2]) as never))).toEqual({
      detail: `${D_P2}:part2_restricted`,
    });
  });

  it("refuses a destroyed / vanished enclosure and fails closed when the reader throws", async () => {
    expect(await guard({ [D_OK]: digestOf({}) })(req(packet([D_OK, D_GONE]) as never))).toEqual({
      detail: `${D_GONE}:not_found`,
    });
    const throwing = buildAppealPacketRenderGuard(() => ({
      documentMetadata: async () => {
        throw new Error("boom");
      },
    }));
    expect(await throwing(req(packet([D_OK]) as never))).toEqual({ detail: `${D_OK}:not_found` });
  });

  it("does not touch any other template", async () => {
    const reader = documents({});
    const g = buildAppealPacketRenderGuard(() => reader as never);
    expect(
      await g(req({ supportingDocuments: [{ documentId: D_OK }] }, "order_record")),
    ).toBeNull();
    expect(reader.documentMetadata).not.toHaveBeenCalled();
  });
});

describe("the render consumer honours the guard as a SETTLED refusal", () => {
  function harness(
    guardImpl: Parameters<typeof buildM22DocumentRequestConsumer>[0]["renderGuard"],
  ) {
    const { store } = createInMemoryDocumentSeamStore();
    const objects = createInMemoryObjectStore();
    const renderer = createDocumentRenderer({ store, objects: objects.store });
    const rendered: string[] = [];
    const refusals: { kind: string; detail: string }[] = [];
    const consumer = buildM22DocumentRequestConsumer({
      store,
      renderer: () => ({
        render: async (scope, templateKey, payload) => {
          rendered.push(templateKey);
          return renderer.render(scope, templateKey, payload);
        },
      }),
      onRefusal: (r) => refusals.push({ kind: r.kind, detail: r.detail }),
      ...(guardImpl ? { renderGuard: guardImpl } : {}),
    });
    return { consumer, rendered, refusals };
  }
  const delivered = (): DispatchableOutboxEvent => ({
    id: "00000000-0000-4000-8000-00000000000e",
    organizationId: ORG,
    eventType: "m25.appeal_packet.render_requested",
    aggregateKind: "appeal_case",
    aggregateId: APPEAL,
    payload: { appealCaseId: APPEAL, tier: "redetermination", payload: packet([D_P2]) },
    attemptCount: 0,
    createdAt: new Date("2026-10-08T00:00:00.000Z"),
  });

  it("renders nothing, reports render_guard_refused and completes the row (no throw, no retry)", async () => {
    const h = harness(async () => ({ detail: `${D_P2}:part2_restricted` }));
    await expect(h.consumer.handle(delivered())).resolves.toBeUndefined();
    expect(h.rendered).toEqual([]);
    expect(h.refusals).toEqual([
      { kind: "render_guard_refused", detail: `${D_P2}:part2_restricted` },
    ]);
  });

  it("renders normally when the guard clears the packet", async () => {
    const h = harness(async () => null);
    await h.consumer.handle(delivered());
    expect(h.rendered).toEqual(["appeal_packet"]);
    expect(h.refusals).toEqual([]);
  });
});

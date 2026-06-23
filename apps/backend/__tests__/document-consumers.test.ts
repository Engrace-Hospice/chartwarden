// apps/backend/__tests__/document-consumers.test.ts — M22-T06 (§4.11 render-handshake consumers).
//
// Covers the PURE consumer core: planDocumentRender (event + payload → render plan, incl. the D21 discharge-source
// discriminator, the M15 plan-kind selector, D23 SUD retention, and the null-on-malformed guard), dispatchDocumentRender
// (run a plan through an injected renderer → the m22.document.rendered back-ref intents + the D22 critical event), and
// the M22_OUTBOX_SUBSCRIPTIONS surface (every binding has a subscription and vice versa). Also covers the portal
// reader's SUD gate now consuming an injected ConsentEvaluator-backed gate (allow → URL; deny / no gate → fail closed).
import { describe, expect, it } from "vitest";
import {
  type DocumentSeamRow,
  type DocumentSeamSeed,
  type PortalSudConsentGate,
  M22_DOCUMENT_REQUESTED_BINDINGS,
  M22_OUTBOX_SUBSCRIPTIONS,
  createInMemoryDocumentReadStore,
  createPortalDocumentReader,
  dispatchDocumentRender,
  inMemoryPortalPresign,
  planDocumentRender,
} from "../src/modules/22-documents/index";

const ORG = "org-1";

describe("planDocumentRender (§4.11 event → render plan)", () => {
  it("maps a fixed-template event to its §4.5 aggregate + floor retention", () => {
    const plan = planDocumentRender("m6.election.signed", {
      organizationId: ORG,
      patientId: "pat-1",
      electionId: "el-1",
    });
    expect(plan).toMatchObject({
      templateKey: "election_statement",
      aggregateType: "election_statement",
      aggregateId: "el-1",
      patientId: "pat-1",
      retentionClass: "compliance",
      critical: false,
      scope: { orgId: ORG },
    });
    // The source aggregate id is normalised onto the uniform `aggregateId` field the renderer reads.
    expect(plan?.renderPayload.aggregateId).toBe("el-1");
  });

  it("applies the D21 external-source discharge discriminator on m6.discharge.created", () => {
    const std = planDocumentRender("m6.discharge.created", {
      organizationId: ORG,
      patientId: "pat-1",
      dischargeEventId: "dc-1",
    });
    expect(std?.templateKey).toBe("discharge_summary");
    expect(std?.aggregateType).toBe("discharge_summary");

    const ext = planDocumentRender("m6.discharge.created", {
      organizationId: ORG,
      patientId: "pat-1",
      dischargeEventId: "dc-1",
      source: "m29_proposal_accept",
    });
    expect(ext?.templateKey).toBe("discharge_summary_v2_external_source");
    // D21 — the variant key still instantiates the discharge_summary aggregate (the back-ref target).
    expect(ext?.aggregateType).toBe("discharge_summary");
  });

  it("selects the M15 discipline-plan template from the single kind-discriminated event", () => {
    const plan = planDocumentRender("m15.plan.version_signed", {
      organizationId: ORG,
      patientId: "pat-1",
      planVersionId: "pv-1",
      kind: "msw_plan",
    });
    expect(plan?.templateKey).toBe("msw_plan");
    expect(plan?.aggregateType).toBe("msw_plan");
    // An unknown kind is not a platform-floor template → no render.
    expect(
      planDocumentRender("m15.plan.version_signed", {
        organizationId: ORG,
        patientId: "pat-1",
        planVersionId: "pv-1",
        kind: "not_a_plan",
      }),
    ).toBeNull();
  });

  it("upgrades lab-results retention to Part 2 on the SUD path (D23) and flags the critical variant (D22)", () => {
    const sud = planDocumentRender("m11.order.results_received", {
      organizationId: ORG,
      patientId: "pat-1",
      orderId: "ord-1",
      sudClass: true,
    });
    expect(sud?.templateKey).toBe("lab_results_pdf");
    expect(sud?.retentionClass).toBe("compliance_42cfr_part2");
    expect(sud?.critical).toBe(false);

    const plain = planDocumentRender("m11.order.results_received", {
      organizationId: ORG,
      patientId: "pat-1",
      orderId: "ord-1",
    });
    expect(plain?.retentionClass).toBe("clinical_record");

    const critical = planDocumentRender("m11.order.results_received_critical", {
      organizationId: ORG,
      patientId: "pat-1",
      orderId: "ord-1",
    });
    expect(critical?.critical).toBe(true);
  });

  it("returns null for an unhandled event or a payload missing org/patient/aggregate id", () => {
    expect(planDocumentRender("m99.unknown.event", { organizationId: ORG, patientId: "p" })).toBeNull();
    // missing organizationId
    expect(planDocumentRender("m6.election.signed", { patientId: "pat-1", electionId: "el-1" })).toBeNull();
    // missing patientId
    expect(planDocumentRender("m6.election.signed", { organizationId: ORG, electionId: "el-1" })).toBeNull();
    // missing the source aggregate id
    expect(planDocumentRender("m6.election.signed", { organizationId: ORG, patientId: "pat-1" })).toBeNull();
  });
});

describe("dispatchDocumentRender (render → m22.document.rendered back-ref)", () => {
  function fakeRenderer(documentId = "doc-rendered-1") {
    const calls: Array<{ templateKey: string; payload: unknown }> = [];
    return {
      calls,
      renderer: {
        async render(_scope: { orgId: string }, templateKey: string, payload: unknown) {
          calls.push({ templateKey, payload });
          return { documentId };
        },
      },
    };
  }

  it("renders the plan and emits a single rendered back-ref for the non-critical path", async () => {
    const { renderer, calls } = fakeRenderer();
    const plan = planDocumentRender("m8.encounter.signed", {
      organizationId: ORG,
      patientId: "pat-1",
      encounterId: "enc-1",
    });
    const events = await dispatchDocumentRender(plan!, { renderer });
    expect(calls).toHaveLength(1);
    expect(calls[0].templateKey).toBe("encounter_pdf");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      eventName: "m22.document.rendered",
      payload: {
        documentId: "doc-rendered-1",
        organizationId: ORG,
        aggregateType: "encounter",
        aggregateId: "enc-1",
        templateKey: "encounter_pdf",
        retentionClass: "clinical_record",
      },
    });
  });

  it("additionally emits rendered_critical_results on the D22 critical-lab path", async () => {
    const { renderer } = fakeRenderer("doc-crit");
    const plan = planDocumentRender("m11.order.results_received_critical", {
      organizationId: ORG,
      patientId: "pat-1",
      orderId: "ord-9",
    });
    const events = await dispatchDocumentRender(plan!, { renderer });
    expect(events.map((e) => e.eventName)).toEqual([
      "m22.document.rendered",
      "m22.document.rendered_critical_results",
    ]);
    expect(events[1].payload).toMatchObject({ documentId: "doc-crit", orderId: "ord-9" });
  });
});

describe("M22_OUTBOX_SUBSCRIPTIONS (§4.11 surface)", () => {
  it("every subscription names a known consumer and binds to a render binding", () => {
    for (const sub of M22_OUTBOX_SUBSCRIPTIONS) {
      expect(sub.consumerName.startsWith("m22.")).toBe(true);
      expect(M22_DOCUMENT_REQUESTED_BINDINGS[sub.eventName]).toBeDefined();
    }
  });

  it("every render binding is subscribed (no orphan binding)", () => {
    const subscribed = new Set(M22_OUTBOX_SUBSCRIPTIONS.map((s) => s.eventName));
    for (const eventName of Object.keys(M22_DOCUMENT_REQUESTED_BINDINGS)) {
      expect(subscribed.has(eventName)).toBe(true);
    }
  });
});

describe("PortalDocumentReader SUD gate (consumes the injected ConsentEvaluator gate)", () => {
  function sudSeed(): DocumentSeamSeed {
    const row: DocumentSeamRow = {
      id: "doc-sud",
      organizationId: ORG,
      patientId: "pat-1",
      aggregateType: "order_record",
      aggregateId: "ord-1",
      title: "Lab (SUD)",
      retentionClass: "compliance_42cfr_part2",
      sourceKind: "form_render",
      status: "active",
      patientFacing: true,
      activeVersionId: "doc-sud-v",
      versionNumber: 1,
      mimeType: "application/pdf",
      byteSize: 100,
      sha256Hex: "a".repeat(64),
      versionsCount: 1,
      sudClass: true,
      downloadFilename: "doc-sud.pdf",
      renderedAt: "2026-06-22T12:00:00.000Z",
      createdAt: "2026-06-22T12:00:00.000Z",
      updatedAt: "2026-06-22T12:00:00.000Z",
    };
    return { documents: [row] };
  }

  const allowGate: PortalSudConsentGate = { async evaluateSudPortalAccess() { return true; } };
  const denyGate: PortalSudConsentGate = { async evaluateSudPortalAccess() { return false; } };

  it("mints a SUD-class portal URL when the consent gate allows", async () => {
    const store = createInMemoryDocumentReadStore(sudSeed()).store;
    const portal = createPortalDocumentReader(store, inMemoryPortalPresign, allowGate);
    const res = await portal.mintPortalDownloadUrl({
      documentVersionId: "doc-sud-v",
      portalSessionId: "sess-1",
      patientId: "pat-1",
      organizationId: ORG,
    });
    expect("url" in res && res.url).toContain("portal/");
  });

  it("denies a SUD-class portal URL when the consent gate denies", async () => {
    const store = createInMemoryDocumentReadStore(sudSeed()).store;
    const portal = createPortalDocumentReader(store, inMemoryPortalPresign, denyGate);
    const res = await portal.mintPortalDownloadUrl({
      documentVersionId: "doc-sud-v",
      portalSessionId: "sess-1",
      patientId: "pat-1",
      organizationId: ORG,
    });
    expect(res).toEqual({ denied: true, reason: "sud_consent_absent" });
  });

  it("fails closed for SUD content when no consent gate is wired (the T05 default)", async () => {
    const store = createInMemoryDocumentReadStore(sudSeed()).store;
    const portal = createPortalDocumentReader(store, inMemoryPortalPresign);
    const res = await portal.mintPortalDownloadUrl({
      documentVersionId: "doc-sud-v",
      portalSessionId: "sess-1",
      patientId: "pat-1",
      organizationId: ORG,
    });
    expect(res).toEqual({ denied: true, reason: "sud_consent_absent" });
  });
});

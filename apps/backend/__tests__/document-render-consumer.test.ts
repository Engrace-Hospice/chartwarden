// apps/backend/__tests__/document-render-consumer.test.ts — GAP-023/024/038. The LIVE §4.11 render-handshake
// consumer: the payload normalizer (each source module's own wire shape → M22's canonical request) and the
// consumer's execution of every {@link decideDocumentRequest} outcome. No DB — the seam store and the
// renderer are the in-memory slices; the live end-to-end proof over real Postgres + the real dispatcher is
// ./gap-023-024-038-render-handshake.live.test.ts.
import { beforeEach, describe, expect, it } from "vitest";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import { M6_OUTBOX_EVENTS } from "../src/modules/06-admission/index";
import { M7_OUTBOX_EVENTS } from "../src/modules/07-care-plan/index";
import { M8_OUTBOX_EVENTS } from "../src/modules/08-encounters/index";
import { M9_OUTBOX_EVENTS } from "../src/modules/09-assessments/index";
import { M10_OUTBOX_EVENTS } from "../src/modules/10-hope/index";
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { M14_OUTBOX_EVENTS } from "../src/modules/14-idg/index";
import { M15_OUTBOX_EVENTS } from "../src/modules/15-discipline-care-plans/index";
import { M16_OUTBOX_EVENTS } from "../src/modules/16-bereavement/index";
import { M17_OUTBOX_EVENTS } from "../src/modules/17-scheduling/index";
import { M18_OUTBOX_EVENTS } from "../src/modules/18-evv/index";
import { M19_OUTBOX_EVENTS } from "../src/modules/19-oncall/index";
import { M20_OUTBOX_EVENTS } from "../src/modules/20-field-safety/index";
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
import { M24_OUTBOX_EVENTS } from "../src/modules/24-billing-medicaid/index";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { M27_OUTBOX_EVENTS } from "../src/modules/27-cost-report/index";
import { M33_OUTBOX_EVENTS } from "../src/modules/33-reporting/index";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/index";

const ORG = "00000000-0000-4000-8000-0000000000ee";
const PAT = "00000000-0000-4000-8000-0000000000aa";
const ORDER = "00000000-0000-4000-8000-0000000000bb";
const ADMISSION = "00000000-0000-4000-8000-0000000000cc";
const SUPPLY_REQUEST = "00000000-0000-4000-8000-0000000000d1";
const DISPATCH = "00000000-0000-4000-8000-0000000000d2";
const RETURN = "00000000-0000-4000-8000-0000000000d3";
const RUN = "00000000-0000-4000-8000-0000000000d4";
const EXPORT = "00000000-0000-4000-8000-0000000000d5";

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

  // M33 (GAP-051) — the second one-wire-name-two-producers case, discriminated by `aggregateType`
  // instead of a bespoke field, because the two artifacts are two different document_aggregate_types.
  it("routes M33's two producers to their own templates and keeps the whole payload as content", () => {
    const snapshot = {
      viewId: "00000000-0000-4000-8000-0000000000f0",
      format: "pdf",
      organizationId: ORG,
      snapshotQuery: "SELECT $1",
      idempotencyKey: RUN,
      title: "Daily Census",
      columns: [{ key: "census_day", sourceKey: "census_day", kind: "dimension" }],
      rows: [{ census_day: "2026-08-01" }],
      rowCount: 1,
    };

    const scheduled = normalizeDocumentRequest({
      eventType: "m33.scheduled_report.render_requested",
      organizationId: ORG,
      aggregateId: RUN, // the report_schedule_run OCCURRENCE
      payload: { ...snapshot, aggregateType: "report_schedule_run", scheduleId: "s1", runId: RUN },
    });
    expect(scheduled.payload.templateKey).toBe("scheduled_report");
    expect(scheduled.payload.aggregateId).toBe(RUN);
    // A report is aggregate-only (D6) — no chart target, so no patient on the document.
    expect(scheduled.payload.patientId).toBeNull();
    expect(scheduled.payload.title).toBe("Daily Census");
    // No `contentField`: the WHOLE payload is the report, rows included.
    expect(scheduled.payload.content).toMatchObject({ rows: snapshot.rows, rowCount: 1 });

    const adhoc = normalizeDocumentRequest({
      eventType: "m33.scheduled_report.render_requested",
      organizationId: ORG,
      aggregateId: EXPORT,
      payload: {
        ...snapshot,
        aggregateType: "report_export",
        exportId: EXPORT,
        aggregateId: EXPORT,
      },
    });
    expect(adhoc.payload.templateKey).toBe("report_export");
    expect(adhoc.payload.aggregateId).toBe(EXPORT);
  });

  // ── F-099 — the six that were emitted and drained by nothing ─────────────────────────────────────────
  // Each case pins the two things that decide whether a rendered document is FINDABLE: the aggregate
  // identity it back-refs, and the chart it lands on. Both were wrong-by-omission before this: M22
  // rendered none of these at all, and four of the payloads carried no patient.

  it("reads M10's HOPE summary request, filing it on the assessment's own patient chart", () => {
    const { event, payload } = normalizeDocumentRequest({
      eventType: "m10.hope.summary_requested",
      organizationId: ORG,
      payload: { assessmentId: ORDER, requestedBy: "user_1", patientId: PAT },
    });
    expect(event).toBe("m10.hope.summary_requested");
    expect(payload.templateKey).toBe("hope_summary");
    expect(payload.aggregateId).toBe(ORDER);
    // The chart target. Without `patientId` on the wire this is null and a patient-scoped clinical
    // summary files against no chart — the reason the producer payload gained the field.
    expect(payload.patientId).toBe(PAT);
  });

  // The aggregate is the PLAN, not the contact: one welcome packet per plan. Keying it on `contactId`
  // would make each additional bereaved contact a fresh render of a document the family already has.
  it("reads M16's welcome packet against the PLAN, with the decedent as the chart", () => {
    const { payload } = normalizeDocumentRequest({
      eventType: "m16.bereavement.outreach_artifact_requested",
      organizationId: ORG,
      payload: {
        planId: ORDER,
        patientId: PAT,
        contactId: DISPATCH,
        outreachId: null,
        templateKey: "bereavement_welcome_packet",
        payloadJsonb: { deathDate: "2026-08-01" },
      },
    });
    expect(payload.templateKey).toBe("bereavement_welcome_packet");
    expect(payload.aggregateId).toBe(ORDER);
    expect(payload.patientId).toBe(PAT);
    expect(payload.content).toEqual({ deathDate: "2026-08-01" });
  });

  it("reads M20's incident report, and a STAFF-safety incident renders with no chart", () => {
    const patientHarm = normalizeDocumentRequest({
      eventType: "m20.safety.incident_report_requested",
      organizationId: ORG,
      payload: { incidentId: ORDER, patientId: PAT, renderTargetKind: "pdf" },
    });
    expect(patientHarm.payload.templateKey).toBe("safety_incident_report");
    expect(patientHarm.payload.aggregateId).toBe(ORDER);
    expect(patientHarm.payload.patientId).toBe(PAT);

    // `safety_incident.patient_id` is nullable because a vehicle accident or a workplace injury has no
    // patient. Null here is the CORRECT outcome — filing that report on someone's chart is worse than
    // filing it on none — which is why the producer sends an explicit null rather than omitting it.
    const staffInjury = normalizeDocumentRequest({
      eventType: "m20.safety.incident_report_requested",
      organizationId: ORG,
      payload: { incidentId: ORDER, patientId: null, renderTargetKind: "pdf" },
    });
    expect(staffInjury.payload.patientId).toBeNull();
  });

  // M25 holds no patient link at all — `appeal_case` reaches a chart only through a NULLABLE `claim_id`
  // into M23 — so this artifact is patient-independent by construction, not by omission. `tier` selects
  // the letter's CONTENT, not a different artifact, so it stays in the content blob.
  it("reads M25's appeal packet as patient-independent, tier riding the content", () => {
    const { payload } = normalizeDocumentRequest({
      eventType: "m25.appeal_packet.render_requested",
      organizationId: ORG,
      payload: { appealCaseId: ORDER, tier: "alj", payload: { denialReason: "MUE" } },
    });
    expect(payload.templateKey).toBe("appeal_packet");
    expect(payload.aggregateId).toBe(ORDER);
    expect(payload.patientId).toBeNull();
    expect(payload.content).toEqual({ denialReason: "MUE" });
  });

  // Three artifacts on one wire name. The aggregate is the SUBMISSION: a reopened cost report submits
  // again, and filing both against `costReportId` would make the second render an idempotent skip.
  it("splits M27's three artifact kinds, keyed on the submission rather than the report", () => {
    const kinds = {
      ecr: "cost_report_ecr",
      pi: "cost_report_pi",
      supporting_doc: "cost_report_supporting_doc",
    };
    for (const [artifactKind, templateKey] of Object.entries(kinds)) {
      const { payload } = normalizeDocumentRequest({
        eventType: "m27.artifact.render_requested",
        organizationId: ORG,
        payload: {
          costReportId: RUN,
          submissionId: ORDER,
          artifactKind,
          payloadRef: EXPORT,
          retentionClass: "compliance",
        },
      });
      expect(payload.templateKey).toBe(templateKey);
      expect(payload.aggregateId).toBe(ORDER);
      expect(payload.patientId).toBeNull();
    }
  });

  it("throws on an M27 artifactKind M22 has no template for", () => {
    expect(() =>
      normalizeDocumentRequest({
        eventType: "m27.artifact.render_requested",
        organizationId: ORG,
        payload: { submissionId: ORDER, artifactKind: "worksheet_s10" },
      }),
    ).toThrow(/worksheet_s10' maps to no M22 template/);
  });

  // `ipu_body_release.release_document_id` is the column this fills, and its schema comment names this
  // template. `patient_id` on that row is NOT NULL, so the decedent's chart is always resolvable.
  it("reads M37's body-release request onto the decedent's chart", () => {
    const { payload } = normalizeDocumentRequest({
      eventType: "m37.body_release.document_requested",
      organizationId: ORG,
      aggregateId: DISPATCH, // the envelope also carries it; the BODY is what the catalog pins
      payload: { organizationId: ORG, bodyReleaseId: ORDER, patientId: PAT },
    });
    expect(payload.templateKey).toBe("body_release_authorization");
    expect(payload.aggregateId).toBe(ORDER);
    expect(payload.patientId).toBe(PAT);
  });

  it("throws on an M37 body-release request carrying no bodyReleaseId", () => {
    expect(() =>
      normalizeDocumentRequest({
        eventType: "m37.body_release.document_requested",
        organizationId: ORG,
        payload: { organizationId: ORG, patientId: PAT },
      }),
    ).toThrow(/names no aggregate id/);
  });

  // ── F-100 — M6's six CoP compliance documents ────────────────────────────────────────────────────────
  // These are the artifacts Medicare surveys ask for: the certification of terminal illness, the election
  // statement, the face-to-face encounter, the notice of rights, the revocation and the discharge summary.
  // Every one has a published template and a `document_id` column, and none was ever rendered.

  it.each([
    ["m6.election.signed", "election_statement", { electionStatementId: ORDER }],
    ["m6.cti.signed", "cti", { ctiId: ORDER }],
    ["m6.f2f.attested", "f2f", { f2fId: ORDER }],
    ["m6.nor.acknowledged", "nor", { norAcknowledgmentId: ORDER }],
    ["m6.revocation.created", "revocation", { revocationEventId: ORDER }],
    ["m6.discharge.created", "discharge_summary", { dischargeEventId: ORDER }],
    ["m6.discharge.cosigned", "discharge_summary", { dischargeEventId: ORDER }],
    // F-192 (#248) — M6's seventh artifact, the transfer summary (both directions, one template).
    ["m6.transfer.created", "discharge_summary_transfer", { transferEventId: ORDER }],
  ])("%s renders %s against its own row, on the patient's chart", (eventType, templateKey, ids) => {
    const { event, payload } = normalizeDocumentRequest({
      eventType,
      organizationId: ORG,
      // The ENVELOPE deliberately carries a different id — for `m6.nor.acknowledged` it is genuinely the
      // ADMISSION, because that transition runs on the admission row. Reading the envelope would file
      // every NOR against an admission id and collide with anything else rendered under one.
      aggregateId: DISPATCH,
      payload: { ...ids, patientId: PAT },
    });
    expect(event).toBe(eventType);
    expect(payload.templateKey).toBe(templateKey);
    expect(payload.aggregateId).toBe(ORDER);
    expect(payload.patientId).toBe(PAT);
  });

  // F-224 (#248) — ONE event, TWO artifacts, discriminated by `recipientKind`; the aggregate is the CALL.
  it.each([
    ["caregiver", "triage_summary_caregiver"],
    ["attending", "triage_summary_attending"],
  ])(
    "m19.triage.summary_requested (%s) renders %s against the call",
    (recipientKind, templateKey) => {
      const { payload } = normalizeDocumentRequest({
        eventType: "m19.triage.summary_requested",
        organizationId: ORG,
        aggregateId: DISPATCH,
        payload: {
          triageCallId: ORDER,
          recipientKind,
          patientId: PAT,
          disposition: "caregiver_education_only",
        },
      });
      expect(payload.templateKey).toBe(templateKey);
      expect(payload.aggregateId).toBe(ORDER);
      expect(payload.patientId).toBe(PAT);
    },
  );

  it("throws on an m19.triage.summary_requested whose recipientKind maps to no template (never a guess)", () => {
    for (const recipientKind of ["family", undefined, "CAREGIVER"]) {
      expect(() =>
        normalizeDocumentRequest({
          eventType: "m19.triage.summary_requested",
          organizationId: ORG,
          aggregateId: DISPATCH,
          payload: { triageCallId: ORDER, recipientKind, patientId: PAT },
        }),
      ).toThrow(/maps to no M22 template|names no template/);
    }
  });

  it("throws on an M6 request whose payload names no source row", () => {
    expect(() =>
      normalizeDocumentRequest({
        eventType: "m6.cti.signed",
        organizationId: ORG,
        aggregateId: DISPATCH,
        payload: { electionPeriodId: ORDER, patientId: PAT },
      }),
    ).toThrow(/names no aggregate id/);
  });

  // F-176 (#248) bound `m6.discharge.cosigned` (appends a discharge_summary version). F-192 (#248) bound
  // `m6.transfer.created` too (`discharge_summary_transfer`, migration 0267) — see the `it.each` above,
  // which now covers it. No pinned "not consumed" list remains for this group.

  it("throws on an M33 aggregateType M22 has no template for", () => {
    expect(() =>
      normalizeDocumentRequest({
        eventType: "m33.scheduled_report.render_requested",
        organizationId: ORG,
        aggregateId: RUN,
        payload: { aggregateType: "report_dashboard", title: "x" },
      }),
    ).toThrow(/report_dashboard' maps to no M22 template/);
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

  it("subscribes to every declared render request — and nothing else", () => {
    expect(harness().consumer.eventTypes).toEqual([
      "m11.order.document_requested",
      "m12.medication_order.document_requested",
      "m13.reconciliation.document_requested",
      "m21.supply_request.document_requested",
      "m23.abn.required",
      "m33.scheduled_report.render_requested",
      // F-099 — six that were emitted from production write paths and drained by nothing.
      "m10.hope.summary_requested",
      "m16.bereavement.outreach_artifact_requested",
      "m20.safety.incident_report_requested",
      "m25.appeal_packet.render_requested",
      "m27.artifact.render_requested",
      "m37.body_release.document_requested",
      // F-100 — M6's six CoP compliance documents. No `m6.document_requested`: the M22 spec routes the
      // SOURCE events here, one template each, which is the `m23.abn.required` shape.
      "m6.election.signed",
      "m6.cti.signed",
      "m6.f2f.attested",
      "m6.nor.acknowledged",
      "m6.revocation.created",
      "m6.discharge.created",
      "m6.discharge.cosigned",
      // F-144 (#248) — four render requests catalogued, spec-named by their producing module's own
      // document-request table, and never emitted anywhere (the producer-side gap, not a declaration
      // gap): the M13 machine's effect list was never read, and M23/M24/M25 had every typed builder and
      // no caller.
      "m13.administration_record.document_requested",
      "m23.billing.document_render_requested",
      "m24.medicaid_billing.document_render_requested",
      "m25.denial_resolution_letter.render_requested",
      // F-161 (#248) — 2 of the 10 "confirmed genuine" events, the two with the most decisive
      // producer-side evidence: M17's caregiver-reminder PDF (`visit_confirmation`, no producer yet on
      // M17's side) and M7's care-plan-signed PDF (new `care_plan` aggregate type, migration 0252).
      "m17.caregiver_reminder_due",
      "m7.care_plan.version_signed",
      // F-192 (#248) — the last of that group: the M22 spec's own "discharge_summary (transfer
      // variant)" — a distinct `document_aggregate_type` (migration 0267), not a second version of the
      // base `discharge_summary` template.
      "m6.transfer.created",
      // F-166 (#248) — five GENESIS-only render requests, all real `document_aggregate_type` enum
      // values since migration 0048 that had never gotten a TemplateDescriptor or a subscription.
      "m8.encounter.signed",
      "m18.evv.aggregator_accepted",
      "m14.packet.render_requested",
      "m14.minutes.signed",
      "m15.plan.version_signed",
      // F-168 (#248) — three requests genuinely blocked ONLY by the idempotency-key-granularity gate
      // (migration 0261): each asks for a NEW VERSION of an aggregate its GENESIS sibling above already
      // rendered.
      "m8.encounter.addendum_signed",
      "m14.minutes.amended",
      "m14.discipline_note.addendum_recorded",
      "m12.medication_order.transmitted",
      // F-208 (#248) — the printable M9 assessment summary. No per-request id on the payload, so
      // `patientId` is the aggregate (the first patientId-keyed render this table binds) and every
      // request — chart-open auto-refresh or the explicit download/print action — appends a new
      // version of one evolving per-patient `assessment_summary` document.
      "m9.assessment.summary_requested",
      // F-224 (#248) — M19's caregiver/attending triage summary (explicit staff action; per-audience template).
      "m19.triage.summary_requested",
    ]);
  });

  // The load-bearing one. `createOutboxDispatcher` THROWS at construction on a consumer that binds an
  // event type absent from the boot catalog ("binds unknown catalog event") — so a phantom name here is
  // not a dead subscription, it is a crashed boot. The pre-fix list carried five of them
  // (`m6.document_requested`, `m9.…`, `m14.…`, `m16.…`, `m23.abn.document_requested`); they were only
  // survivable because nothing was ever bound. This pins each subscribed name to a real producer
  // declaration that names m22 as a consumer, so a producer-side rename fails here rather than at boot.
  it("every subscribed event is declared by its producer, with m22 among its consumers", () => {
    // Hand-listed on purpose, and SELF-CHECKING: a subscribed event whose producer catalog is missing
    // from this list fails below as "not declared by any producer catalog", exactly as if the producer
    // had renamed it. So the list cannot silently fall behind — adding a producer module to
    // M22_DOCUMENT_REQUEST_EVENTS and not to this import list is a red test, never a quiet pass.
    const declared = new Map(
      [
        ...M6_OUTBOX_EVENTS,
        ...M7_OUTBOX_EVENTS,
        ...M8_OUTBOX_EVENTS,
        ...M9_OUTBOX_EVENTS,
        ...M10_OUTBOX_EVENTS,
        ...M11_OUTBOX_EVENTS,
        ...M12_OUTBOX_EVENTS,
        ...M13_OUTBOX_EVENTS,
        ...M14_OUTBOX_EVENTS,
        ...M15_OUTBOX_EVENTS,
        ...M16_OUTBOX_EVENTS,
        ...M17_OUTBOX_EVENTS,
        ...M18_OUTBOX_EVENTS,
        ...M19_OUTBOX_EVENTS,
        ...M20_OUTBOX_EVENTS,
        ...M21_OUTBOX_EVENTS,
        ...M23_OUTBOX_EVENTS,
        ...M24_OUTBOX_EVENTS,
        ...M25_OUTBOX_EVENTS,
        ...M27_OUTBOX_EVENTS,
        ...M33_OUTBOX_EVENTS,
        ...M37_OUTBOX_EVENTS,
      ].map(
        // `e.eventName` widened to `string`: M17's own catalog (events-by-m17.ts's own header comment)
        // deliberately relaxes single-segment alert names below the stricter `OutboxEventName` template
        // (`m${number}.${string}.${string}`) — `m17.caregiver_reminder_due` has only one dot — so the
        // Map's key type must not be narrowed to that template or `.get()` below fails to accept it.
        (e) => [e.eventName as string, e] as const,
      ),
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

  // F-099 end-to-end: the six requests that were emitted with nothing draining them now produce a real
  // `document` row through the SAME decide → render → back-ref path M11's does. The per-source assertion
  // is `renderedDocumentForAggregate`, because the (aggregate_type, aggregate_id) pair IS how a source
  // module finds its own document — a render filed under the wrong pair is as lost as one never made.
  it("renders each of the six previously-undrained requests against its own aggregate", async () => {
    const cases = [
      {
        eventType: "m10.hope.summary_requested",
        aggregateKind: "hope_assessment",
        payload: { assessmentId: ORDER, requestedBy: "user_1", patientId: PAT },
        templateKey: "hope_summary",
        aggregateType: "hope_summary",
        patientId: PAT,
      },
      {
        eventType: "m16.bereavement.outreach_artifact_requested",
        aggregateKind: "bereavement_plan",
        payload: {
          planId: ORDER,
          patientId: PAT,
          contactId: DISPATCH,
          outreachId: null,
          templateKey: "bereavement_welcome_packet",
          payloadJsonb: {},
        },
        templateKey: "bereavement_welcome_packet",
        aggregateType: "bereavement_letter",
        patientId: PAT,
      },
      {
        eventType: "m20.safety.incident_report_requested",
        aggregateKind: "safety_incident",
        payload: { incidentId: ORDER, patientId: null, renderTargetKind: "pdf" },
        templateKey: "safety_incident_report",
        aggregateType: "safety_incident_report",
        patientId: null,
      },
      {
        eventType: "m25.appeal_packet.render_requested",
        aggregateKind: "appeal_case",
        payload: { appealCaseId: ORDER, tier: "redetermination", payload: {} },
        templateKey: "appeal_packet",
        aggregateType: "appeal_packet",
        patientId: null,
      },
      {
        eventType: "m27.artifact.render_requested",
        aggregateKind: "ecr_submission",
        payload: {
          costReportId: RUN,
          submissionId: ORDER,
          artifactKind: "ecr",
          payloadRef: EXPORT,
          retentionClass: "compliance",
        },
        templateKey: "cost_report_ecr",
        aggregateType: "cost_report_ecr",
        patientId: null,
      },
      {
        eventType: "m37.body_release.document_requested",
        aggregateKind: "ipu_body_release",
        payload: { organizationId: ORG, bodyReleaseId: ORDER, patientId: PAT },
        templateKey: "body_release_authorization",
        aggregateType: "body_release_authorization",
        patientId: PAT,
      },
    ] as const;

    for (const c of cases) {
      const h = harness();
      await h.consumer.handle(
        delivered({
          eventType: c.eventType,
          aggregateKind: c.aggregateKind,
          aggregateId: ORDER,
          payload: c.payload,
        }),
      );
      expect(h.refusals, `${c.eventType} was refused`).toEqual([]);
      expect(h.rendered, `${c.eventType} rendered nothing`).toHaveLength(1);
      expect(h.rendered[0]?.templateKey).toBe(c.templateKey);
      const doc = await h.store.renderedDocumentForAggregate({
        aggregateType: c.aggregateType,
        aggregateId: ORDER,
        organizationId: ORG,
      });
      expect(doc, `${c.eventType} filed no document row`).not.toBeNull();
      expect(h.rendered[0]?.payload).toMatchObject({ aggregateId: ORDER });
      // The chart target reaches the renderer, including the deliberate nulls (a staff-safety incident,
      // an appeal M25 cannot link to a patient, an org-level cost-report artifact).
      expect((h.rendered[0]?.payload as { patientId: string | null }).patientId).toBe(c.patientId);
    }
  });

  // F-100 — the resolved routing must WIN over the content blob. This is not a style point: M6's
  // `runEffects` puts the TRANSITION's aggregate in the payload body, so with the blob spread last every
  // NOR rendered under its ADMISSION's id. The document existed, addressed to the wrong row, and the
  // back-ref could never match — the one failure mode a back-ref cannot recover from, because there IS a
  // document and it looks fine.
  it("a content blob carrying its own aggregateId/patientId never overrides the resolved routing", async () => {
    const h = harness();
    const ADMISSION = "00000000-0000-4000-8000-00000000ad01";
    const OTHER_PATIENT = "00000000-0000-4000-8000-00000000ad02";
    await h.consumer.handle(
      delivered({
        eventType: "m6.nor.acknowledged",
        aggregateKind: "admission",
        aggregateId: ADMISSION,
        payload: {
          norAcknowledgmentId: ORDER,
          patientId: PAT,
          // Exactly what `runEffects` writes: the transition ran on the ADMISSION, so its id is in the
          // body beside the NOR's own.
          aggregateId: ADMISSION,
          admissionId: ADMISSION,
          otherPatientId: OTHER_PATIENT,
        },
      }),
    );
    expect(h.rendered).toHaveLength(1);
    expect(h.rendered[0]?.payload).toMatchObject({ aggregateId: ORDER, patientId: PAT });
    // And the row is filed against the NOR, which is what makes it findable from the NOR.
    expect(
      await h.store.renderedDocumentForAggregate({
        aggregateType: "nor",
        aggregateId: ORDER,
        organizationId: ORG,
      }),
    ).not.toBeNull();
    expect(
      await h.store.renderedDocumentForAggregate({
        aggregateType: "nor",
        aggregateId: ADMISSION,
        organizationId: ORG,
      }),
    ).toBeNull();
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

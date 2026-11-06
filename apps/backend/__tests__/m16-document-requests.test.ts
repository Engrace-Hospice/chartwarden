// apps/backend/__tests__/m16-document-requests.test.ts — ADR-0109 D6 / D9: the M22 handoff behind
// `m16.bereavement.document_requested` (the approved physician condolence letter and the internal discharge summary).
// Proves the event is a LIVE M22 subscription with the right wire shape (aggregate = `aggregateId`, the template named by the
// payload, `payloadJsonb` the content), that both templates resolve to their internal aggregate types, that the discharge
// summary renders a real PDF stating offered-versus-delivered per contact and cadence item, and that nothing the typed schema
// does not declare (contact notes, care goals, risk factors, substance-use data) can reach the page.
import {
  type BereavementDischargeSummaryRenderPayload,
  RenderPayloadError,
  assertBereavementDischargeSummaryRenderPayload,
  assertBereavementPhysicianLetterRenderPayload,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { M16_OUTBOX_EVENTS } from "../src/modules/16-bereavement/index";
import {
  M22_ANTICIPATED_DOCUMENT_REQUEST_EVENTS,
  M22_DOCUMENT_REQUEST_EVENTS,
  normalizeDocumentRequest,
} from "../src/modules/22-documents/index";
import { renderPdfForTemplate } from "../src/modules/22-documents/render-pdf";
import { buildBereavementDischargeSummaryDoc } from "../src/modules/22-documents/render-pdf/bereavement-discharge-summary-doc";
import { PLATFORM_TEMPLATE_TABLE } from "../src/modules/22-documents/seams/renderer";

const ORG = "org-1";
const PLAN = "00000000-0000-4000-8000-000000000001";
const PATIENT = "00000000-0000-4000-8000-000000000002";
const LETTER = "00000000-0000-4000-8000-000000000003";
const CLOSURE = "00000000-0000-4000-8000-000000000004";

const textOf = (bytes: Uint8Array): string =>
  [
    ...Buffer.from(bytes)
      .toString("latin1")
      .matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g),
  ]
    .map((m) => (m[1] ?? "").replace(/\\([()\\])/g, "$1"))
    .join("\n");

const SUMMARY: BereavementDischargeSummaryRenderPayload = {
  deathDate: "2025-10-01",
  closedAt: "2026-11-05T08:00:00.000Z",
  closureReason: "thirteen_month_completion",
  closeKind: "auto",
  planTierTrajectory: [
    { at: "2025-10-01T09:00:00.000Z", tier: "low" },
    { at: "2026-01-12T09:00:00.000Z", tier: "moderate" },
  ],
  contacts: [
    {
      displayName: "Pat Example",
      relationship: "spouse",
      status: "active",
      mailingsAllowed: false,
      tierTrajectory: [{ at: "2025-10-01T09:00:00.000Z", tier: "moderate" }],
      touchpoints: [
        {
          cadenceMark: "condolence_letter",
          kind: "sympathy_letter",
          dueAt: "2025-10-03T00:00:00.000Z",
          status: "completed",
          completedAt: "2025-10-03T15:00:00.000Z",
        },
        {
          cadenceMark: "nine_month",
          kind: "phone_call",
          dueAt: "2026-06-28T00:00:00.000Z",
          status: "missed",
          completedAt: null,
        },
        {
          cadenceMark: "closeout_letter",
          kind: "sympathy_letter",
          dueAt: "2026-10-26T00:00:00.000Z",
          status: "cancelled",
          completedAt: null,
        },
      ],
      assessmentTasks: [
        {
          taskKind: "initial_assessment",
          status: "completed",
          dueAt: "2025-10-29T00:00:00.000Z",
          completedAt: "2025-10-30T10:00:00.000Z",
        },
        {
          taskKind: "midpoint_reassessment",
          status: "missed",
          dueAt: "2026-03-30T00:00:00.000Z",
          completedAt: null,
        },
      ],
      optOuts: [
        { optOutKind: "no_mailings", channelKinds: [], optedOutAt: "2026-02-01T00:00:00.000Z" },
      ],
      unreachable: null,
    },
    {
      displayName: "Sam Example",
      relationship: "child",
      status: "unreachable",
      mailingsAllowed: true,
      tierTrajectory: [],
      touchpoints: [],
      assessmentTasks: [],
      optOuts: [],
      unreachable: {
        attemptCount: 3,
        lastAttemptAt: "2026-01-20T17:30:00.000Z",
        markedUnreachableAt: "2026-01-21T00:00:00.000Z",
      },
    },
  ],
  totals: { offered: 3, delivered: 1, missed: 1, cancelled: 1, outstanding: 0 },
};

describe("m16.bereavement.document_requested is a live M22 subscription", () => {
  it("is consumed, not merely anticipated, and M16's catalog declares it for m22", () => {
    expect(M22_DOCUMENT_REQUEST_EVENTS).toContain("m16.bereavement.document_requested");
    expect(M22_ANTICIPATED_DOCUMENT_REQUEST_EVENTS as readonly string[]).not.toContain(
      "m16.bereavement.document_requested",
    );
    const event = M16_OUTBOX_EVENTS.find(
      (e) => e.eventName === "m16.bereavement.document_requested",
    );
    expect(event?.declaredConsumers).toEqual(["m22"]);
  });

  it("reads the physician letter against the LETTER, with the decedent as the chart and payloadJsonb as the content", () => {
    const { payload } = normalizeDocumentRequest({
      eventType: "m16.bereavement.document_requested",
      organizationId: ORG,
      payload: {
        planId: PLAN,
        patientId: PATIENT,
        documentKind: "physician_condolence_letter",
        aggregateId: LETTER,
        templateKey: "bereavement_physician_condolence_letter",
        payloadJsonb: { deathDate: "2026-11-01", personalNote: null },
      },
    });
    expect(payload.templateKey).toBe("bereavement_physician_condolence_letter");
    expect(payload.aggregateId).toBe(LETTER);
    expect(payload.patientId).toBe(PATIENT);
    expect(payload.content).toEqual({ deathDate: "2026-11-01", personalNote: null });
  });

  it("reads the discharge summary against the CLOSURE, not the plan", () => {
    const { payload } = normalizeDocumentRequest({
      eventType: "m16.bereavement.document_requested",
      organizationId: ORG,
      payload: {
        planId: PLAN,
        patientId: PATIENT,
        documentKind: "discharge_summary",
        aggregateId: CLOSURE,
        templateKey: "bereavement_discharge_summary_internal",
        payloadJsonb: SUMMARY,
      },
    });
    expect(payload.templateKey).toBe("bereavement_discharge_summary_internal");
    expect(payload.aggregateId).toBe(CLOSURE);
    expect(payload.content).toEqual(SUMMARY);
  });

  it("resolves both templates to internal aggregate types under the bereavement retention class", () => {
    expect(PLATFORM_TEMPLATE_TABLE.bereavement_physician_condolence_letter?.aggregateType).toBe(
      "bereavement_physician_letter",
    );
    expect(PLATFORM_TEMPLATE_TABLE.bereavement_discharge_summary_internal?.aggregateType).toBe(
      "bereavement_discharge_summary",
    );
    for (const key of [
      "bereavement_physician_condolence_letter",
      "bereavement_discharge_summary_internal",
    ]) {
      expect(PLATFORM_TEMPLATE_TABLE[key]?.retentionClass).toBe("bereavement");
    }
  });
});

describe("the physician condolence letter renders through the structured generic builder", () => {
  it("draws the note and the death date into a real PDF", () => {
    const payload = assertBereavementPhysicianLetterRenderPayload({
      deathDate: "2026-11-01",
      personalNote: "Thank you for walking this family home with such care.",
    });
    const bytes = renderPdfForTemplate(
      "bereavement_physician_condolence_letter",
      payload,
      "Physician Condolence Letter",
    );
    const text = textOf(bytes);
    expect(Buffer.from(bytes).toString("latin1").startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("Physician Condolence Letter");
    expect(text).toContain("walking this family home");
  });

  it("refuses a note over 1000 characters at the schema", () => {
    expect(() =>
      assertBereavementPhysicianLetterRenderPayload({
        deathDate: "2026-11-01",
        personalNote: "x".repeat(1001),
      }),
    ).toThrow(RenderPayloadError);
  });
});

describe("bereavement_discharge_summary_internal (bespoke)", () => {
  const text = textOf(
    renderPdfForTemplate(
      "bereavement_discharge_summary_internal",
      assertBereavementDischargeSummaryRenderPayload(SUMMARY),
      "Bereavement Program Discharge Summary (Internal)",
    ),
  );

  it("states the closure facts and the offered-versus-delivered totals", () => {
    expect(text).toContain("Bereavement Program Discharge Summary (Internal)");
    expect(text).toContain("Thirteen Month Completion");
    expect(text).toContain("2025-10-01");
    expect(text).toContain("Cadence items offered");
    expect(text).toContain("Internal record for auditors");
  });

  it("lists every cadence item with its kind, due date, status and completion, the 9-month call as Month 9", () => {
    expect(text).toContain("Condolence Letter");
    expect(text).toContain("Month 9 call");
    expect(text).toContain("Missed");
    expect(text).toContain("Cancelled");
    expect(text).toContain("2025-10-03");
    expect(text).toContain("Closeout letter");
  });

  it("states the assessment checkpoints done and missed", () => {
    expect(text).toContain("Initial Assessment");
    expect(text).toContain("Midpoint Reassessment");
  });

  it("states the unreachable contact's attempt count and last attempt, the opt-out scope and the mailing stop", () => {
    expect(text).toContain("3 attempt(s)");
    expect(text).toContain("2026-01-20 17:30 UTC");
    expect(text).toContain("No Mailings");
    expect(text).toContain("Stopped (calls continue)");
  });

  it("states the tier trajectory", () => {
    expect(text).toContain("Moderate");
    expect(text).toContain("2026-01-12");
  });

  it("never draws a field the schema does not declare (notes, goals, factors, substance-use) even if a producer put it on the wire", () => {
    const leaky = {
      ...SUMMARY,
      contactNotes: "SECRET-NOTE-TEXT",
      contacts: SUMMARY.contacts.map((c) => ({
        ...c,
        careGoals: ["SECRET-CARE-GOAL"],
        riskFactors: { activeSubstanceUse: true, narrative: "SECRET-FACTOR-NARRATIVE" },
        notes: "SECRET-CONTACT-NOTE",
        substanceUse: "SECRET-SUD",
        optOuts: c.optOuts.map((o) => ({ ...o, reason: "SECRET-OPT-OUT-REASON" })),
      })),
    };
    const drawn = textOf(
      renderPdfForTemplate("bereavement_discharge_summary_internal", leaky, "x"),
    );
    for (const secret of [
      "SECRET-NOTE-TEXT",
      "SECRET-CARE-GOAL",
      "SECRET-FACTOR-NARRATIVE",
      "SECRET-CONTACT-NOTE",
      "SECRET-SUD",
      "SECRET-OPT-OUT-REASON",
    ]) {
      expect(drawn).not.toContain(secret);
    }
    // the schema itself fails closed on a producer that keeps an undeclared field out of band
    expect(() =>
      assertBereavementDischargeSummaryRenderPayload({ ...SUMMARY, closeKind: "x" }),
    ).toThrow(RenderPayloadError);
  });

  it("degrades to an empty-roster page instead of throwing on a payload with no contacts", () => {
    const doc = buildBereavementDischargeSummaryDoc({
      ...SUMMARY,
      contacts: [],
      totals: { offered: 0, delivered: 0, missed: 0, cancelled: 0, outstanding: 0 },
    });
    expect(JSON.stringify(doc.blocks)).toContain("no bereaved contacts");
  });
});

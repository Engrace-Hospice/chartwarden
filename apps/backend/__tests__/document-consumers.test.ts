// apps/backend/__tests__/document-consumers.test.ts — M22-T06 the §4.11 outbox subscriptions + §4.12
// disclosure gates. Exercises the pure {@link decideDocumentRequest} over each LIVE source-module render
// request (M11 / M12 / M13 / M23), the D14 idempotency no-op, the §7.16 SUD-consent gate, and the §4.12
// external-BAA presign gate — plus the two impure real-seam resolvers ({@link resolveSudConsentPresent} /
// {@link resolveExternalBaaActive}) over fake seams registered into the M1 registry. No DB.
// The consumer that feeds this decider from the dispatcher is ./document-render-consumer.test.ts (unit)
// and ./gap-023-024-038-render-handshake.live.test.ts (over real Postgres).
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import {
  type DocumentRequestEvent,
  type DocumentRequestFacts,
  type DocumentRequestPayload,
  M22_ANTICIPATED_DOCUMENT_REQUEST_EVENTS,
  M22_DOCUMENT_RENDER_CONSUMER,
  M22_DOCUMENT_REQUEST_BINDINGS,
  M22_DOCUMENT_REQUEST_BINDINGS_DEFERRED,
  M22_DOCUMENT_REQUEST_EVENTS,
  decideDocumentRequest,
  resolveExternalBaaActive,
  resolveSudConsentPresent,
} from "../src/modules/22-documents/index";

const ORG = "00000000-0000-4000-8000-0000000000ee";
const PAT = "00000000-0000-4000-8000-0000000000aa";
const AGG = "00000000-0000-4000-8000-0000000000bb";

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────

function payload(over: Partial<DocumentRequestPayload> = {}): DocumentRequestPayload {
  return {
    organizationId: ORG,
    templateKey: "cti",
    aggregateId: AGG,
    patientId: PAT,
    content: { foo: "bar" },
    ...over,
  };
}

/** A template-known, idempotency-clean, no-gate fact set (the happy-path baseline). */
function facts(over: Partial<DocumentRequestFacts> = {}): DocumentRequestFacts {
  return {
    alreadyRendered: false,
    templateKnown: true,
    aggregateType: "cti",
    retentionClass: "compliance",
    ...over,
  };
}

// ── §4.11 event catalog + forward-declared binding ──────────────────────────────────────────────────────

describe("M22-T06 — §4.11 outbox subscriptions catalog", () => {
  it("subscribes to exactly the render-request events some module's catalog actually declares", () => {
    expect(M22_DOCUMENT_REQUEST_EVENTS).toEqual([
      "m11.order.document_requested",
      "m12.medication_order.document_requested",
      "m13.reconciliation.document_requested",
      "m21.supply_request.document_requested",
      "m23.abn.required",
      "m33.scheduled_report.render_requested",
      // F-099 — six REQUEST-spelled events emitted from production write paths with nothing draining
      // them. They were filed under the m22 outbox-deferral group whose stated reason was that these
      // declarations are the SOURCE spelling of a handshake already wired through the request spelling.
      // That reason was true of the other ~70 and false of these six, and a reason that fits most of a
      // group reads as a decision covering all of it.
      "m10.hope.summary_requested",
      "m16.bereavement.outreach_artifact_requested",
      "m20.safety.incident_report_requested",
      "m25.appeal_packet.render_requested",
      "m27.artifact.render_requested",
      "m37.body_release.document_requested",
      // F-100 — M6's six CoP compliance documents. M6 emits no `*.document_requested`; the M22 spec's own
      // consumer table routes these SOURCE events here, one template each. All six templates were already
      // published and six `document_id` columns were already waiting — only the subscription was missing.
      "m6.election.signed",
      "m6.cti.signed",
      "m6.f2f.attested",
      "m6.nor.acknowledged",
      "m6.revocation.created",
      "m6.discharge.created",
      // F-144 (#248) — four render requests catalogued, spec-named by their producing module's own
      // document-request table, and never emitted anywhere (the producer-side gap): the M13 machine's
      // effect list was never read, and M23/M24/M25 had every typed builder and no caller.
      "m13.administration_record.document_requested",
      "m23.billing.document_render_requested",
      "m24.medicaid_billing.document_render_requested",
      "m25.denial_resolution_letter.render_requested",
      // F-16x (#248) — two render requests M22's own spec names as producer-side commitments, corrected
      // from the misattributions F-144 found (M17's own catalog: "M22 renders the reminder"; M7's own
      // catalog: "drives … M22 PDF").
      "m17.caregiver_reminder_due",
      "m7.care_plan.version_signed",
      // F-166 (#248) — five GENESIS-only render requests, all real `document_aggregate_type` enum
      // values since migration 0048 that had never gotten a TemplateDescriptor or a subscription.
      "m8.encounter.signed",
      "m18.evv.aggregator_accepted",
      "m14.packet.render_requested",
      "m14.minutes.signed",
      "m15.plan.version_signed",
      // F-168 (#248) — three requests genuinely blocked ONLY by the idempotency-key-granularity gate
      // (migration 0261, `document_version.source_event_id`): each asks for a NEW VERSION of an
      // aggregate its own GENESIS sibling above already rendered.
      "m8.encounter.addendum_signed",
      "m14.minutes.amended",
      "m12.medication_order.transmitted",
    ]);
  });

  // GAP-038 — the regression this list exists to prevent. M22 used to subscribe to
  // `m23.abn.document_requested`, a name NO module declares; M23's catalog declares `m23.abn.required`.
  // The dispatcher routes off the catalog, so the subscription was permanently unreachable while looking
  // exactly like coverage.
  it("names no event that is not in some module's catalog (the ABN-mismatch regression)", () => {
    expect(M22_DOCUMENT_REQUEST_EVENTS as readonly string[]).not.toContain(
      "m23.abn.document_requested",
    );
    expect(M22_DOCUMENT_REQUEST_EVENTS).toContain("m23.abn.required");
    // The anticipated list is where a name with no declaring producer belongs — listed, NOT subscribed.
    for (const e of M22_ANTICIPATED_DOCUMENT_REQUEST_EVENTS) {
      expect(M22_DOCUMENT_REQUEST_EVENTS).not.toContain(e);
    }
  });

  it("declares one binding per event, all routed to the shared render consumer, LIVE", () => {
    expect(M22_DOCUMENT_REQUEST_BINDINGS_DEFERRED).toBe(false); // GAP-023/024/038 wired the dispatcher
    expect(M22_DOCUMENT_REQUEST_BINDINGS).toHaveLength(M22_DOCUMENT_REQUEST_EVENTS.length);
    for (const b of M22_DOCUMENT_REQUEST_BINDINGS) {
      expect(b.consumerName).toBe(M22_DOCUMENT_RENDER_CONSUMER);
      expect(M22_DOCUMENT_REQUEST_EVENTS).toContain(b.eventName);
    }
  });
});

// ── pure decider — render happy path across source modules ──────────────────────────────────────────────

describe("M22-T06 — decideDocumentRequest renders + emits a back-ref (§4.11)", () => {
  const cases: ReadonlyArray<{
    event: DocumentRequestEvent;
    templateKey: string;
    aggregateType: DocumentRequestFacts["aggregateType"];
    retentionClass: DocumentRequestFacts["retentionClass"];
  }> = [
    // One row per LIVE consumed event, each paired with the template that event genuinely asks for (the
    // pairs `REQUEST_SHAPES` in render-consumer.ts produces). The table used to carry M6/M9/M14/M16 rows
    // for events no module declares — the decider is generic over (event, template), so those rows proved
    // nothing the four real ones do not.
    {
      event: "m11.order.document_requested",
      templateKey: "order_record",
      aggregateType: "order_record",
      retentionClass: "clinical_record",
    },
    {
      event: "m12.medication_order.document_requested",
      templateKey: "medication_order",
      aggregateType: "medication_order",
      retentionClass: "clinical_record",
    },
    {
      event: "m13.reconciliation.document_requested",
      templateKey: "medication_reconciliation_worksheet",
      aggregateType: "medication_reconciliation_worksheet",
      retentionClass: "clinical_record",
    },
    {
      // M21 — one event, two artifacts, discriminated by `documentKind` in the normalizer.
      event: "m21.supply_request.document_requested",
      templateKey: "comfort_kit_return_receipt",
      aggregateType: "comfort_kit_return_receipt",
      retentionClass: "compliance",
    },
    {
      event: "m23.abn.required",
      templateKey: "abn",
      aggregateType: "abn",
      retentionClass: "compliance", // GAP-038 — the published descriptor's real class (a CMS notice)
    },
  ];

  for (const c of cases) {
    it(`renders ${c.templateKey} from ${c.event} with the back-ref the source module links on`, () => {
      const action = decideDocumentRequest(
        c.event,
        payload({ templateKey: c.templateKey }),
        facts({ aggregateType: c.aggregateType, retentionClass: c.retentionClass }),
      );
      expect(action.kind).toBe("render");
      if (action.kind !== "render") throw new Error("unreachable");
      expect(action.render.templateKey).toBe(c.templateKey);
      expect(action.render.aggregateType).toBe(c.aggregateType);
      expect(action.render.retentionClass).toBe(c.retentionClass);
      expect(action.render.aggregateId).toBe(AGG);
      expect(action.render.patientId).toBe(PAT);
      expect(action.render.sudRedacted).toBe(false);
      // the back-ref carries the routing the requesting module applies document_id against
      expect(action.backRef.sourceEvent).toBe(c.event);
      expect(action.backRef.aggregateId).toBe(AGG);
      expect(action.backRef.aggregateType).toBe(c.aggregateType);
      expect(action.backRef.retentionClass).toBe(c.retentionClass);
    });
  }

  it("passes the template content + override title straight through to the planned render", () => {
    const action = decideDocumentRequest(
      "m11.order.document_requested",
      payload({ content: { electionDate: "2026-01-01" }, title: "Hospice Election" }),
      facts(),
    );
    if (action.kind !== "render") throw new Error("expected render");
    expect(action.render.content).toEqual({ electionDate: "2026-01-01" });
    expect(action.render.title).toBe("Hospice Election");
  });

  it("plans a patient-independent render (intake/batch) when patientId is absent", () => {
    const action = decideDocumentRequest(
      "m11.order.document_requested",
      payload({ patientId: null }),
      facts(),
    );
    if (action.kind !== "render") throw new Error("expected render");
    expect(action.render.patientId).toBeNull();
  });
});

// ── pure decider — idempotency (D14) ────────────────────────────────────────────────────────────────────

describe("M22-T06 — idempotent re-delivery never double-renders (D14)", () => {
  it("returns idempotent_skip when a prior render already back-refs the (event, aggregate)", () => {
    const action = decideDocumentRequest(
      "m11.order.document_requested",
      payload(),
      facts({ alreadyRendered: true }),
    );
    expect(action.kind).toBe("idempotent_skip");
  });

  it("idempotency wins even when the template is unknown / SUD / external (no work at all)", () => {
    const action = decideDocumentRequest(
      "m11.order.document_requested",
      payload({ isSudClass: true, externalRecipient: { kind: "facility", id: "fac_x" } as never }),
      facts({ alreadyRendered: true, templateKnown: false }),
    );
    expect(action.kind).toBe("idempotent_skip");
  });
});

// ── pure decider — unknown template (§7.2) ──────────────────────────────────────────────────────────────

describe("M22-T06 — unknown template is retried-then-dead-lettered, no document row (§7.2)", () => {
  it("returns unknown_template when the key has no published descriptor", () => {
    const action = decideDocumentRequest(
      "m11.order.document_requested",
      payload({ templateKey: "not_a_real_template" }),
      facts({ templateKnown: false, aggregateType: null, retentionClass: null }),
    );
    expect(action.kind).toBe("unknown_template");
    if (action.kind !== "unknown_template") throw new Error("unreachable");
    expect(action.templateKey).toBe("not_a_real_template");
  });
});

// ── pure decider — §7.16 SUD-consent gate ───────────────────────────────────────────────────────────────

describe("M22-T06 — §7.16 SUD-class render refuses when M39 consent is absent", () => {
  it("refuses (sud_consent_absent) for a SUD-class request with no active consent", () => {
    const action = decideDocumentRequest(
      "m11.order.document_requested",
      payload({ templateKey: "order_record", isSudClass: true }),
      facts({
        aggregateType: "order_record",
        retentionClass: "compliance_42cfr_part2",
        sudConsentPresent: false,
      }),
    );
    expect(action.kind).toBe("sud_consent_absent");
  });

  it("renders a SUD-class request (flagged sudRedacted) when consent IS present", () => {
    const action = decideDocumentRequest(
      "m11.order.document_requested",
      payload({ templateKey: "order_record", isSudClass: true }),
      facts({
        aggregateType: "order_record",
        retentionClass: "compliance_42cfr_part2",
        sudConsentPresent: true,
      }),
    );
    expect(action.kind).toBe("render");
    if (action.kind !== "render") throw new Error("unreachable");
    expect(action.render.sudRedacted).toBe(true);
    expect(action.render.retentionClass).toBe("compliance_42cfr_part2");
  });

  it("does not invoke the SUD gate for a non-SUD request", () => {
    const action = decideDocumentRequest(
      "m11.order.document_requested",
      payload({ isSudClass: false }),
      facts({ sudConsentPresent: undefined }),
    );
    expect(action.kind).toBe("render");
  });
});

// ── pure decider — §4.12 external-BAA presign gate ──────────────────────────────────────────────────────

describe("M22-T06 — §4.12 external disclosure is blocked when the M40 BAA gate is inactive", () => {
  it("blocks (baa_inactive) an external-recipient render when the BAA is not active", () => {
    const action = decideDocumentRequest(
      "m11.order.document_requested",
      payload({
        templateKey: "order_record",
        externalRecipient: { kind: "facility", mdmEntityId: "fac_partner_lab" },
      }),
      facts({
        aggregateType: "order_record",
        retentionClass: "clinical_record",
        externalBaaActive: false,
      }),
    );
    expect(action.kind).toBe("baa_inactive");
    if (action.kind !== "baa_inactive") throw new Error("unreachable");
    expect(action.mdmEntityId).toBe("fac_partner_lab");
  });

  it("renders an external-recipient request once the BAA gate is active", () => {
    const action = decideDocumentRequest(
      "m11.order.document_requested",
      payload({
        templateKey: "order_record",
        externalRecipient: { kind: "facility", mdmEntityId: "fac_partner_lab" },
      }),
      facts({
        aggregateType: "order_record",
        retentionClass: "clinical_record",
        externalBaaActive: true,
      }),
    );
    expect(action.kind).toBe("render");
  });

  it("applies the SUD gate before the BAA gate (SUD refusal takes precedence)", () => {
    const action = decideDocumentRequest(
      "m11.order.document_requested",
      payload({
        templateKey: "order_record",
        isSudClass: true,
        externalRecipient: { kind: "payer", mdmEntityId: "payer_x" },
      }),
      facts({
        aggregateType: "order_record",
        retentionClass: "compliance_42cfr_part2",
        sudConsentPresent: false,
        externalBaaActive: false,
      }),
    );
    expect(action.kind).toBe("sud_consent_absent");
  });
});

// ── impure resolvers — the REAL M39 / M40 seams via getSeam ─────────────────────────────────────────────

describe("M22-T06 — resolveSudConsentPresent consumes the real M39 ConsentEvaluator seam", () => {
  afterEach(() => __resetSeamsForTest());

  it("returns true when the ConsentEvaluator allows the 42 CFR Part 2 release", async () => {
    registerSeam("ConsentEvaluator", {
      evaluate: async (args: { consentType: string; callerModule: string }) => {
        expect(args.consentType).toBe("42_cfr_part_2_release");
        expect(args.callerModule).toBe("m22");
        return { allowed: true };
      },
    } as never);
    expect(await resolveSudConsentPresent({ organizationId: ORG, patientId: PAT })).toBe(true);
  });

  it("fail-closes (false) when consent is denied", async () => {
    registerSeam("ConsentEvaluator", {
      evaluate: async () => ({ allowed: false, denyReason: "no_active_consent" }),
    } as never);
    expect(await resolveSudConsentPresent({ organizationId: ORG, patientId: PAT })).toBe(false);
  });

  it("fail-closes (false) when the seam throws / is a deny-stub", async () => {
    registerSeam("ConsentEvaluator", {
      evaluate: async () => {
        throw new Error("SEAM_NOT_IMPLEMENTED");
      },
    } as never);
    expect(await resolveSudConsentPresent({ organizationId: ORG, patientId: PAT })).toBe(false);
  });
});

describe("M22-T06 — resolveExternalBaaActive consumes the real M40 BaaStatusProvider seam", () => {
  afterEach(() => __resetSeamsForTest());

  it("returns true when the BAA gate is active, threading asOf to the entity", async () => {
    const asOf = new Date("2026-06-24T00:00:00.000Z");
    registerSeam("BaaStatusProvider", {
      baaStatusByMdmEntity: async (input: { kind: string; id: string; asOf: Date }) => {
        expect(input.kind).toBe("facility");
        expect(input.id).toBe("fac_partner_lab");
        expect(input.asOf).toBe(asOf);
        return { isActive: true, status: "executed" };
      },
    } as never);
    const ok = await resolveExternalBaaActive({
      organizationId: ORG,
      recipient: { kind: "facility", mdmEntityId: "fac_partner_lab" },
      asOf,
    });
    expect(ok).toBe(true);
  });

  it("fail-closes (false) when the BAA is missing / expired", async () => {
    registerSeam("BaaStatusProvider", {
      baaStatusByMdmEntity: async () => ({ isActive: false, status: "missing" }),
    } as never);
    const ok = await resolveExternalBaaActive({
      organizationId: ORG,
      recipient: { kind: "facility", mdmEntityId: "fac_x" },
    });
    expect(ok).toBe(false);
  });

  it("fail-closes (false) when the seam throws / is a deny-stub", async () => {
    registerSeam("BaaStatusProvider", {
      baaStatusByMdmEntity: async () => {
        throw new Error("SEAM_NOT_IMPLEMENTED");
      },
    } as never);
    const ok = await resolveExternalBaaActive({
      organizationId: ORG,
      recipient: { kind: "referral_source", mdmEntityId: "ref_x" },
    });
    expect(ok).toBe(false);
  });
});

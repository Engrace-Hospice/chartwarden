import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import {
  type DocLensCapabilityPort,
  buildProvenance,
  planCommitIntents,
  runExtractionPipeline,
} from "@wardenx/intake-extraction";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
// apps/backend/__tests__/document-workflow-acceptance.test.ts — M22-T11 the §7 workflow-acceptance suite
// (the FINAL M22 task). One block per §7 workflow, exercised end-to-end over the REAL composed T03–T10
// machines/services (no re-mocks): the §7.2 W2 render handshake (the DocumentRenderer seam over its
// in-memory slice), W1 DocLens extraction (flag-OFF 503 path through the full M1 middleware chain + the
// flag-ON pure pipeline over a fake M32 capability), W5 statement-of-disagreement, the §7.16 SUD-redaction,
// the §7.12/§7.13/§7.15 EVV/encounter/lab render variants, the §4.12 BAA-gated external presign (the real
// signed-URL service over a fake M40 BaaStatusProvider seam), the §2.4 patient-merge redirect, the W14
// legal-hold-blocks-destruction + DEK-first eraser, and the §8.6/D9/D23 retention disposition.
//
// Deterministic: no infra, injected clock/short-id. The route-auth handshake (§4.6/§4.7) + the wire status
// codes are proven in document-routes.test.ts; the pure deciders have their own unit suites
// (document-lifecycle / document-consumers / document-doclens / document-render-variants / document-readers /
// document-seams). This suite asserts the WORKFLOW outcomes (the acceptance criteria of §7) end-to-end and
// fills the §9 eraser coverage gap (W14 had no dedicated test prior to T11). RLS layer-independence (§9.3)
// lives in rls-isolation.live.test.ts.
import type { DocLensIntakeEnqueue } from "../src/modules/22-documents/extraction/intake-queue";
import {
  type AmendmentDeniedPayload,
  type DocumentFeatureFlagReader,
  type DocumentSideEffect,
  DocumentStateError,
  type MergeFacts,
  SUD_REDACTED_PLACEHOLDER,
  SUD_REDACTION_BANNER,
  SUD_RETENTION_CLASS,
  type SignedUrlObjectResolver,
  StatementOfDisagreementError,
  UnknownTemplateError,
  applyPatientMergeCascade,
  // W1 DocLens (T08)
  createDocLensPipelineService,
  // §7.2 W2 render handshake (T04 seam)
  createDocumentRenderer,
  // W14 eraser (T10)
  createInMemoryDocumentEraseStore,
  createInMemoryDocumentSeamStore,
  createInMemoryObjectStore,
  // §4.12 BAA-gated external presign (T07 signed-URL service over T06 BAA gate)
  createSignedUrlService,
  deriveDispositionDate,
  eraseDocumentRecord,
  isDestructionEligible,
  planDestructionForDocument,
  planEncounterRender,
  planEvvVerificationRender,
  planLabResultsRender,
  // §7.5 / §7.12 / §7.13 / §7.15 / §7.16 render variants (T09)
  planStatementOfDisagreement,
  redactSudValue,
  registerDocLensExtractionRoutes,
  resolveInsertRetentionClass,
  // §2.4 patient-merge redirect + §8.6 retention disposition + W14 lifecycle (T03)
  resolvePatientRedirect,
  transitionDocument,
} from "../src/modules/22-documents/index";
import { CTI } from "./_m22-form-fixtures";

const ORG = "org_a";
const PAT = "00000000-0000-4000-8000-0000000000aa";
const AGG = "00000000-0000-4000-8000-0000000000bb";
const NOW = "2026-06-24T00:00:00.000Z";

const scope = { orgId: ORG };

afterEach(() => __resetSeamsForTest());

// ── W2 — §7.2 Form Render Handshake (D3/D6) ─────────────────────────────────────────────────────────────

describe("M22-T11 §7.2 W2 — form render handshake", () => {
  /** A renderer over its in-memory T04 slices, deterministic clock + short-id. */
  function makeRenderer() {
    const { store } = createInMemoryDocumentSeamStore();
    const objSlice = createInMemoryObjectStore();
    let n = 0;
    const renderer = createDocumentRenderer({
      store,
      objects: objSlice.store,
      now: () => NOW,
      shortId: () => (++n).toString(16).padStart(12, "0"),
    });
    return { renderer, store, liveObjects: objSlice.objects };
  }

  it("renders a typed CTI payload → object written under a PHI-free key + a queryable back-ref (W2 AC)", async () => {
    const { renderer, store, liveObjects } = makeRenderer();
    const { documentId } = await renderer.render(scope, "cti", {
      ...CTI,
      aggregateId: "cti-1",
      patientId: PAT,
    });
    expect(documentId).toMatch(/^[0-9a-f-]{36}$/);
    // the bytes landed under an opaque, patient-prefixed, PHI-free key (D1/D11) — no free-text title.
    const key = [...liveObjects.keys()][0] as string;
    expect(key.startsWith(`tenant-${ORG}/documents/${PAT}/cti/`)).toBe(true);
    expect(key).not.toContain("Certification");
    // the source module's back-ref resolves to the rendered document (the consumer applies document_id).
    const back = await store.renderedDocumentForAggregate({
      aggregateType: "cti",
      aggregateId: "cti-1",
      organizationId: ORG,
    });
    expect(back?.documentId).toBe(documentId);
    expect(back?.renderedAt).toBe(NOW);
  });

  it("an addendum re-render is a NEW VERSION, not a new document (W2 addendum AC)", async () => {
    const { renderer, store } = makeRenderer();
    const v1 = await renderer.render(scope, "encounter", {
      aggregateId: "enc-1",
      patientId: "pat-9",
    });
    const v2 = await renderer.render(scope, "encounter", {
      aggregateId: "enc-1",
      patientId: "pat-9",
    });
    expect(v2.documentId).toBe(v1.documentId);
    const back = await store.renderedDocumentForAggregate({
      aggregateType: "encounter",
      aggregateId: "enc-1",
      organizationId: ORG,
    });
    expect(back?.documentId).toBe(v1.documentId);
  });

  it("a terminal render failure (unknown template) creates NO document row (W2 failure AC)", async () => {
    const { renderer, liveObjects } = makeRenderer();
    await expect(renderer.render(scope, "not-a-template", { aggregateId: "x" })).rejects.toThrow(
      UnknownTemplateError,
    );
    expect(liveObjects.size).toBe(0);
  });
});

// ── W1 — §7.1 DocLens intake → extraction → review → writeback ───────────────────────────────────────────

const fakeCapability: DocLensCapabilityPort = {
  async classifyPages() {
    return {
      status: "ok",
      value: [
        { pageNumber: 1, documentType: "discharge_summary", confidence: 0.96 },
        { pageNumber: 2, documentType: "discharge_summary", confidence: 0.93 },
        { pageNumber: 3, documentType: "lab", confidence: 0.4 },
      ],
    };
  },
  async extract() {
    return {
      status: "ok",
      value: [
        {
          fieldPath: "patient.address",
          value: "12 Oak St",
          riskLevel: "low",
          confidence: 0.98,
          sudDetected: false,
          sourcePageNumber: 1,
        },
        {
          fieldPath: "medications[0].name",
          value: "methadone",
          riskLevel: "high",
          confidence: 0.88,
          sudDetected: true,
          sourcePageNumber: 2,
        },
        {
          fieldPath: "patient.allergy",
          value: "penicillin (anaphylaxis)",
          riskLevel: "high",
          confidence: 0.91,
          sudDetected: false,
          sourcePageNumber: 2,
        },
      ],
    };
  },
  async verify(args) {
    return {
      status: "ok",
      value: args.candidates.map((c) => ({
        fieldPath: c.fieldPath,
        verified: true,
        confidence: 0.95,
      })),
    };
  },
};

describe("M22-T11 §7.1 W1 — DocLens extraction (flag-ON pure pipeline over a fake M32)", () => {
  const BATCH = "b0000000-0000-4000-8000-0000000000aa";
  const JOB = "60000000-0000-4000-8000-000000000001";
  const SRC_DOC = "70000000-0000-4000-8000-000000000001";

  it("runs parse→classify→extract→discrepancy→review: D4 disables bulk-approve, W4 raises the SUD banner", async () => {
    const result = await runExtractionPipeline(fakeCapability, {
      organizationId: ORG,
      batchId: BATCH,
      jobId: JOB,
      pageCount: 3,
      chartValues: [
        { fieldPath: "patient.allergy", value: "penicillin (rash)", targetModule: "m5" },
      ],
    });
    expect(result.status).toBe("ready_for_review");
    if (result.status !== "ready_for_review") return;
    expect(result.review.bulkApproveAllowed).toBe(false); // a HIGH-risk candidate is in scope (D4)
    expect(result.review.sudDetected).toBe(true); // W4 SUD banner
    const disc = result.review.discrepancies.find((d) => d.fieldPath === "patient.allergy");
    expect(disc?.kind).toBe("chart_existing");
    expect(disc?.chartValue).toBe("penicillin (rash)");
  });

  it("commits ONLY approved candidates + records provenance back to (job, source-doc, page) — W1 steps 11–12", async () => {
    const run = await runExtractionPipeline(fakeCapability, {
      organizationId: ORG,
      batchId: BATCH,
      jobId: JOB,
      pageCount: 3,
      chartValues: [],
    });
    if (run.status !== "ready_for_review") throw new Error("expected ready_for_review");
    const chartTargets = [
      { fieldPath: "patient.address", value: null, targetModule: "m5" as const },
      { fieldPath: "medications[0].name", value: null, targetModule: "m12" as const },
      { fieldPath: "patient.allergy", value: null, targetModule: "m5" as const },
    ];
    const decisions = [
      { fieldPath: "patient.address", decision: "approve" as const },
      { fieldPath: "medications[0].name", decision: "reject" as const }, // rejected → no commit intent
      {
        fieldPath: "patient.allergy",
        decision: "approve_with_edit" as const,
        editedValue: "penicillin (anaphylaxis, confirmed)",
      },
    ];
    const intents = planCommitIntents(run.review.candidates, chartTargets, decisions);
    expect(intents.map((i) => i.fieldPath).sort()).toEqual(["patient.address", "patient.allergy"]);
    const provenance = buildProvenance(JOB, SRC_DOC, run.review.candidates, decisions, intents);
    expect(provenance).toHaveLength(2);
    expect(provenance.find((p) => p.fieldPath === "patient.address")).toMatchObject({
      jobId: JOB,
      sourceDocumentId: SRC_DOC,
      sourcePageNumber: 1,
      decision: "approve",
    });
  });
});

describe("M22-T11 §7.1 W1 — DocLens flag gate (default OFF → EXTRACTION_DISABLED through the full chain)", () => {
  const BATCH = "b0000000-0000-4000-8000-0000000000aa";
  const JOB = "60000000-0000-4000-8000-000000000001";
  const RUN = `/api/v1/intake/uploads/${BATCH}/extraction/run`;

  function headerAuth(request: FastifyRequest): void {
    const user = request.headers["x-test-user"];
    if (typeof user !== "string" || user.length === 0) return;
    request.context.userId = user;
    // documents-routes.ts's actorOf() reads the acting MEMBERSHIP id from here (not ctx.userId).
    request.context.attributes.membershipId = user;
    const org = request.headers["x-test-org"];
    request.context.organizationId = typeof org === "string" ? org : "";
    const roles = request.headers["x-test-roles"];
    request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  }

  beforeEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
  });
  afterEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
  });

  function server(flags?: DocumentFeatureFlagReader, intake?: DocLensIntakeEnqueue) {
    const grantStore = createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "rn_1",
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["intake.review"] },
        ],
      },
    ]);
    registerEffectivePermissionResolver(grantStore.store);
    registerAbacRegistry();
    const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    const pipeline = createDocLensPipelineService({ capability: fakeCapability, flags });
    registerDocLensExtractionRoutes(app, { pipeline, flags, ...(intake ? { intake } : {}) });
    return app;
  }

  const authed = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn" };

  it("returns 503 EXTRACTION_DISABLED with Retry-After: 0 when the flag is OFF (Phase-1 default)", async () => {
    const app = server();
    const res = await app.inject({
      method: "POST",
      url: RUN,
      headers: authed,
      payload: { jobId: JOB, pageCount: 3 },
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("0");
    expect(res.json().error.code).toBe("EXTRACTION_DISABLED");
    await app.close();
  });

  it("enqueues the intake job (202 queued) when the flag is injected ON (F-236: the run is a background job)", async () => {
    const enqueued: unknown[] = [];
    const app = server(
      {
        async forOrg() {
          return { "documents.doclens": true };
        },
      },
      { enqueue: async (job) => void enqueued.push(job) },
    );
    const res = await app.inject({
      method: "POST",
      url: RUN,
      headers: authed,
      payload: { jobId: JOB, pageCount: 3 },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("queued");
    expect(enqueued).toHaveLength(1);
    await app.close();
  });

  it("the Authorization Contract still 403s without intake.review BEFORE the flag gate", async () => {
    const app = server();
    const res = await app.inject({
      method: "POST",
      url: RUN,
      headers: { ...authed, "x-test-user": "nobody" },
      payload: { jobId: JOB, pageCount: 3 },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

// ── W5 — §7.5 Statement of Disagreement attachment (D13) ────────────────────────────────────────────────

describe("M22-T11 §7.5 W5 — statement of disagreement", () => {
  function denied(over: Partial<AmendmentDeniedPayload> = {}): AmendmentDeniedPayload {
    return {
      amendmentId: AGG,
      patientId: PAT,
      organizationId: ORG,
      decision: "denied",
      statementText:
        "I disagree with the recorded allergy; I have never had a penicillin reaction.",
      denialReason: "The chart entry is supported by the admitting H&P.",
      ...over,
    };
  }

  it("attaches the SoD as an append-only version with attach_to_disclosures + the amendment tag (W5 AC)", () => {
    const plan = planStatementOfDisagreement({
      payload: denied(),
      versionId: "v1",
      currentMaxVersion: 0,
    });
    expect(plan.templateKey).toBe("patient_amendment_statement_of_disagreement");
    expect(plan.attachEffects).toContainEqual({
      kind: "set_field",
      field: "attach_to_disclosures",
      value: "true",
    });
    expect(plan.attachEffects).toContainEqual({
      kind: "outbox",
      event: "m22.document.statement_of_disagreement_published",
    });
    expect(plan.content.statementText).toContain("I disagree");
  });

  it("a non-denied amendment yields NO SoD (only a denial attaches a statement)", () => {
    expect(() =>
      planStatementOfDisagreement({
        payload: denied({ decision: "approved" }),
        versionId: "v1",
        currentMaxVersion: 0,
      }),
    ).toThrow(StatementOfDisagreementError);
  });
});

// ── §7.16 W-M22-23 — SUD-class result renders the redacted placeholder ──────────────────────────────────

describe("M22-T11 §7.16 W-M22-23 — SUD redaction (PDF-grep guarantee)", () => {
  function labPayload() {
    return {
      orderId: AGG,
      patientId: PAT,
      orderingPhysician: "Dr. Vega",
      signedAt: NOW,
      resultValues: [
        {
          observationId: "o1",
          loincCode: "2823-3",
          label: "Potassium",
          value: "5.2",
          unit: "mEq/L",
          isSudClass: false,
        },
        {
          observationId: "o2",
          loincCode: "19357-1",
          label: "Methadone, urine",
          value: "positive",
          unit: null,
          isSudClass: true,
        },
      ],
    };
  }

  it("redacts the SUD-class row, banners it, and forces compliance_42cfr_part2 when consent absent (W-M22-23 AC)", () => {
    const v = planLabResultsRender({ payload: labPayload(), consentPresent: false });
    expect(v.sudRedacted).toBe(true);
    expect(v.retentionClassOverride).toBe(SUD_RETENTION_CLASS);
    expect(v.content.sudBanner).toBe(SUD_REDACTION_BANNER);
    const rows = v.content.resultValues as Array<{ value: string | null; redacted: boolean }>;
    expect(rows[0]?.value).toBe("5.2"); // non-SUD plaintext stays
    expect(rows[1]?.value).toBe(SUD_REDACTED_PLACEHOLDER); // SUD redacted
    // the PDF-binary-grep guarantee: no plaintext SUD value anywhere in the render content.
    expect(JSON.stringify(v.content)).not.toContain("positive");
  });

  it("a consent-present render passes the SUD value through (no redaction, clinical_record stays)", () => {
    const v = planLabResultsRender({ payload: labPayload(), consentPresent: true });
    expect(v.sudRedacted).toBe(false);
    expect(v.retentionClassOverride).toBeUndefined();
    const rows = v.content.resultValues as Array<{ value: string | null }>;
    expect(rows[1]?.value).toBe("positive");
  });

  it("the redact helper never reveals the SUD plaintext in the placeholder (defense in depth)", () => {
    const out = redactSudValue({
      value: "positive (methadone)",
      isSudClass: true,
      consentPresent: false,
    });
    expect(out.redacted).toBe(true);
    expect(out.value).toBe(SUD_REDACTED_PLACEHOLDER);
    expect(out.value).not.toContain("methadone");
  });
});

// ── W12 / W13 / W-M22-22 — EVV / encounter / lab render variants ─────────────────────────────────────────

describe("M22-T11 §7.12/§7.13/§7.15 W12/W13/W-M22-22 — render variants", () => {
  it("W12 EVV: a geo-verified visit renders the map snapshot; an alternate-method visit the exception narrative", () => {
    const geo = planEvvVerificationRender({
      evvRecordId: "evv1",
      patientId: PAT,
      visitId: "v1",
      aggregatorRefId: "a1",
      acceptedAt: NOW,
      geoVerification: { lat: 45.5, lng: -122.6, mapSnapshotRef: "snap1" },
    });
    expect((geo.content.geoSection as { kind: string }).kind).toBe("map_snapshot");
    const alt = planEvvVerificationRender({
      evvRecordId: "evv2",
      patientId: PAT,
      visitId: "v2",
      aggregatorRefId: "a2",
      acceptedAt: NOW,
      alternateMethodReason: "rural area, no GPS signal",
    });
    expect((alt.content.geoSection as { kind: string; narrative: string }).narrative).toContain(
      "rural area, no GPS signal",
    );
  });

  it("W13 encounter: the AI-narrative sidebar + capability-disclosure footer appear only with an M32 enhancement", () => {
    const plain = planEncounterRender({
      encounterId: "e1",
      patientId: PAT,
      signedAt: NOW,
      signedByClinician: "Nurse Ada",
      body: { narrative: "Resting comfortably." },
    });
    expect((plain.content.aiNarrativeSidebar as { present: boolean }).present).toBe(false);
    expect(plain.content.capabilityDisclosureFooter).toBe(false);
    const enhanced = planEncounterRender({
      encounterId: "e2",
      patientId: PAT,
      signedAt: NOW,
      signedByClinician: "Nurse Ada",
      body: { narrative: "Resting comfortably." },
      aiNarrative: {
        text: "Suggested summary…",
        capabilityId: "cap_narr",
        reviewedByClinician: "Nurse Ada",
      },
    });
    expect((enhanced.content.aiNarrativeSidebar as { present: boolean }).present).toBe(true);
    expect(enhanced.content.capabilityDisclosureFooter).toBe(true);
  });

  it("W-M22-22 lab: an all-non-SUD result renders full plaintext → clinical_record, no SUD flag", () => {
    const v = planLabResultsRender({
      payload: {
        orderId: AGG,
        patientId: PAT,
        orderingPhysician: "Dr. Vega",
        signedAt: NOW,
        resultValues: [
          {
            observationId: "o1",
            loincCode: "2823-3",
            label: "Potassium",
            value: "5.2",
            unit: "mEq/L",
            isSudClass: false,
          },
        ],
      },
      consentPresent: false,
    });
    expect(v.aggregateType).toBe("order_record");
    expect(v.sudRedacted).toBe(false);
    expect(v.retentionClassOverride).toBeUndefined();
    expect((v.content.resultValues as Array<{ value: string }>)[0]?.value).toBe("5.2");
  });
});

// ── §4.12 — BAA-gated external presign (signed-URL service over the real M40 seam) ──────────────────────

describe("M22-T11 §4.12 — external-disclosure presign gates on the M40 BAA status (fail-closed)", () => {
  const VERSION = "d0000000-0000-4000-8000-000000000001";
  const DOC = "c0000000-0000-4000-8000-0000000000aa";

  /** A resolver whose version targets an out-of-network facility → the §4.12 BAA gate applies. */
  const externalResolver: SignedUrlObjectResolver = {
    async loadObject() {
      return {
        objectKey: `documents/${PAT}/discharge_summary/${DOC}/v1.pdf`,
        externalRecipient: { kind: "facility", mdmEntityId: "fac_partner_lab" },
        // F-197 (#248) — not SUD-class; this describe block exercises the §4.12 BAA gate only.
        patientId: PAT,
        isSudClass: false,
      };
    },
  };

  function service() {
    return createSignedUrlService({
      storage: {
        async presignDownload({ descriptor }) {
          return {
            url: `https://minio.example/${descriptor.bucket}/${descriptor.objectKey}?X-Amz-Expires=${descriptor.ttlSeconds}`,
            expiresAt: "2026-06-24T00:05:00.000Z",
          };
        },
      },
      resolver: externalResolver,
    });
  }

  const mintArgs = {
    organizationId: ORG,
    documentId: DOC,
    versionId: VERSION,
    purpose: "disclosure" as const,
  };

  it("blocks the external presign (403) when the M40 BAA is missing/inactive", async () => {
    registerSeam("BaaStatusProvider", {
      baaStatusByMdmEntity: async () => ({ isActive: false, status: "missing" }),
    } as never);
    await expect(service().mint(mintArgs)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("mints the presign once the BAA gate is active (≤300s TTL floor honoured)", async () => {
    registerSeam("BaaStatusProvider", {
      baaStatusByMdmEntity: async () => ({ isActive: true, status: "executed" }),
    } as never);
    const out = await service().mint(mintArgs);
    expect(out.url).toContain("X-Amz-Expires=300");
    expect(out.accessKind).toBe("disclosure_export");
  });

  it("fail-CLOSES (403) when the M40 seam throws / is a deny-stub", async () => {
    registerSeam("BaaStatusProvider", {
      baaStatusByMdmEntity: async () => {
        throw new Error("SEAM_NOT_IMPLEMENTED");
      },
    } as never);
    await expect(service().mint(mintArgs)).rejects.toMatchObject({ statusCode: 403 });
  });
});

// ── §2.4 — patient-merge redirect-on-fetch ──────────────────────────────────────────────────────────────

describe("M22-T11 §2.4 — patient-merge redirect", () => {
  function facts(map: Record<string, string>): MergeFacts {
    return { survivorOf: (id) => map[id] ?? null };
  }

  it("a merged patient redirects through the chain to the final survivor; re-point to any other id is refused", () => {
    const r = resolvePatientRedirect("pat-1", facts({ "pat-1": "pat-2", "pat-2": "pat-3" }));
    expect(r.survivingPatientId).toBe("pat-3");
    expect(r.hops).toBe(2);
    const f = facts({ "pat-1": "pat-2" });
    expect(applyPatientMergeCascade({ current: "pat-1", requested: "pat-2", facts: f })).toBe(
      "pat-2",
    );
    expect(() =>
      applyPatientMergeCascade({ current: "pat-1", requested: "pat-9", facts: f }),
    ).toThrow(DocumentStateError);
  });
});

// ── W14 — §7.14 cryptographic shred: legal hold blocks destruction + DEK-first eraser ───────────────────

describe("M22-T11 §7.14 W14 — legal-hold-blocks-destruction + the DEK-first eraser", () => {
  it("a legally-held document can NEVER be tombstoned (LEGAL_HOLD_BLOCKS_DESTRUCTION)", () => {
    try {
      transitionDocument("legal_hold", {
        type: "tombstone",
        certificateId: "cert-1",
        objectKeys: ["k"],
        bucket: "tenant-org_a",
        at: NOW,
      });
      expect.unreachable();
    } catch (e) {
      expect((e as DocumentStateError).code).toBe("LEGAL_HOLD_BLOCKS_DESTRUCTION");
    }
  });

  it("destruction of an unheld active doc is version-aware: destroy_objects + shred_dek + null_active + access_log + tombstoned/completed events", () => {
    const t = transitionDocument("active", {
      type: "tombstone",
      certificateId: "cert-1",
      objectKeys: ["documents/pat-1/cti/doc-1/cti-a.pdf", "documents/pat-1/cti/doc-1/cti-b.pdf"],
      bucket: "tenant-org_a",
      at: NOW,
    });
    expect(t.to).toBe("destroyed_tombstone");
    expect(
      t.effects.filter(
        (e): e is Extract<DocumentSideEffect, { kind: "destroy_objects" }> =>
          e.kind === "destroy_objects",
      )[0]?.objectKeys ?? [],
    ).toHaveLength(2);
    expect(t.effects.some((e) => e.kind === "shred_dek")).toBe(true);
    expect(t.effects.some((e) => e.kind === "null_active_version")).toBe(true);
    expect(t.effects.some((e) => e.kind === "access_log")).toBe(true); // §164.528 — appended, never deleted
    const events = t.effects
      .filter((e): e is Extract<DocumentSideEffect, { kind: "outbox" }> => e.kind === "outbox")
      .map((e) => e.event);
    expect(events).toEqual(
      expect.arrayContaining(["m22.document.tombstoned", "m22.eraser.completed"]),
    );
  });

  it("planDestructionForDocument skips a held doc (m22.eraser.legal_hold_skip) and proceeds (null) for an unheld doc", () => {
    const skip = planDestructionForDocument({
      status: "active",
      legalHoldActive: true,
      certificateId: "cert-1",
      legalHoldEventId: "lh-1",
      at: NOW,
    });
    expect(skip?.skipped).toBe(true);
    expect(
      skip!.effects
        .filter((e): e is Extract<DocumentSideEffect, { kind: "outbox" }> => e.kind === "outbox")
        .map((e) => e.event),
    ).toContain("m22.eraser.legal_hold_skip");
    expect(
      planDestructionForDocument({
        status: "active",
        legalHoldActive: false,
        certificateId: "cert-1",
        legalHoldEventId: null,
        at: NOW,
      }),
    ).toBeNull();
  });

  it("eraseDocumentRecord is DEK-first: crypto-erases the payloads BEFORE deleting rows; skips held + Part-2 docs", async () => {
    const skips = {
      legalHoldDocumentIds: ["held-1", "held-2", "held-3"],
      part2DocumentIds: ["p2-1"],
    };
    const { store, cryptoErased } = createInMemoryDocumentEraseStore(
      { documents: 97, documentVersions: 140, minioObjects: 240 },
      skips,
    );
    const out = await eraseDocumentRecord(ORG, PAT, store);
    expect(cryptoErased).toEqual([PAT]); // crypto-erase ran (DEK-first)
    expect(out.counts.documents).toBe(97);
    expect(out.skips.legalHoldDocumentIds).toHaveLength(3); // W14 AC: 3 held docs preserved + reported
    expect(out.skips.part2DocumentIds).toEqual(["p2-1"]); // Part-2 passed through to M4 refusal
    expect(out.erased).toBeGreaterThan(0);
    // idempotent: a second erase removes nothing (rows + objects already gone).
    const again = await eraseDocumentRecord(ORG, PAT, store);
    expect(again.counts.documents).toBe(0);
  });
});

// ── §8.6 / D9 / D23 — retention disposition & auto-tagging ───────────────────────────────────────────────

describe("M22-T11 §8.6/D9/D23 — retention disposition", () => {
  it("legal hold overrides retention: an intake_artifact past its 30-day disposition is NOT eligible while held", () => {
    const held = deriveDispositionDate({
      retentionClass: "intake_artifact",
      dispositionAt: "2020-01-01T00:00:00.000Z",
      legalHoldActive: true,
    });
    expect(held.heldByLegalHold).toBe(true);
    expect(held.dueAt).toBeNull();
    expect(isDestructionEligible({ verdict: held, now: NOW })).toBe(false);
  });

  it("an unheld intake_artifact is eligible only past its disposition date", () => {
    const v = deriveDispositionDate({
      retentionClass: "intake_artifact",
      dispositionAt: "2026-06-01T00:00:00.000Z",
      legalHoldActive: false,
    });
    expect(isDestructionEligible({ verdict: v, now: "2026-06-15T00:00:00.000Z" })).toBe(false);
    expect(isDestructionEligible({ verdict: v, now: "2026-08-01T00:00:00.000Z" })).toBe(true);
  });

  it("D23 auto-tags compliance_42cfr_part2 for a SUD-class observation; a clean observation stays clinical_record", () => {
    expect(
      resolveInsertRetentionClass({
        proposed: "clinical_record",
        labResultSudClass: true,
        doclensSudClass: false,
        partTwoOverride: false,
      }),
    ).toBe("compliance_42cfr_part2");
    expect(
      resolveInsertRetentionClass({
        proposed: "clinical_record",
        labResultSudClass: false,
        doclensSudClass: false,
        partTwoOverride: false,
      }),
    ).toBe("clinical_record");
  });
});

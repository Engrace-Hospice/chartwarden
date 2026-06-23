// apps/backend/__tests__/document-workflow-acceptance.test.ts — M22-T11, the §7 workflow-acceptance suite (the
// FINAL M22 task, closing M22 Documents). It pins the §12 sign-off behaviours that the pure domain + the §7
// render-variant resolvers + the in-memory route service reach deterministically — the binding behaviours §9's
// E2E plan asserts on staging, expressed here over the same code the routes/consumers/eraser compose. The
// complementary §9.3 / §8.8 RLS half — the database backstop across all 17 owned tables — lives in
// packages/db/migrations/__tests__/rls-isolation.live.test.ts (the M22 block, real Postgres, verified in M22-T10).
// Together the two layers each INDEPENDENTLY block the cross-tenant violation (defence in depth, §8.8).
//
// Scenarios map to the §12.6 workflow checklist + the §12.2 retention sign-off reachable without infra:
//   W2  (§7.2)  — the form-render handshake: event → render plan → `m22.document.rendered` back-ref documentId.
//   W5  (§7.5)  — Statement of Disagreement: render only on a DENIED amendment + the SoD-published outbox intent.
//   W8  (§7.8)  — HIGH-risk per-field-only: the bulk-approve ABAC predicate denies a high-risk review scope.
//   W9  (§7.9)  — version history: a re-version APPENDS (append-only ledger; monotonic; active flips to the head).
//   W10 (§7.10) — signed-URL TTL clamp (5 min non-portal) + the opaque, PHI-free download filename (D11/SEC-015).
//   W12 (§7.12) — EVV verification render: geo block vs alternate-method narrative.
//   W13 (§7.13) — encounter PDF render: signed → v1; addendum → a NEW version on the SAME document.
//   W14 (§7.14) — the eraser: legal-hold skip + `compliance_42cfr_part2` lifetime-refusal + the tombstone read-block.
//   W-M22-22/23 (§7.15/§7.16) — lab results: Phase-1 inert (M29 deny-stub) → live non-SUD plaintext → SUD redaction.
//   DocLens OFF (§8.10) — every extraction path 503 `EXTRACTION_DISABLED` while `documents.doclens` is off.
//   §12.2 retention — D9 intake_artifact promotion, D23 SUD immutability + downgrade-forbidden, D12 destruction.
// Each pure machine has its own exhaustive unit suite (document-lifecycle / render-variants / eraser / routes);
// this asserts the WORKFLOW outcomes over the services the §4 routes + §4.11 consumers compose over.
import type { AbacContext } from "@wardenx/auth";
import { SUD_REDACTED_PLACEHOLDER } from "@wardenx/forms";
import { describe, expect, it } from "vitest";
import {
  type DocumentEraseCandidate,
  type LabObservationReader,
  DocumentRouteService,
  assertRetentionClassChange,
  buildDocumentAbacPredicates,
  clampSignedUrlTtlSeconds,
  createInMemoryDocumentEraseStore,
  decideDestruction,
  denyStubLabObservationReader,
  dispatchDocumentRender,
  eraseDocumentRecord,
  opaqueDownloadFilename,
  planDocumentRender,
  renderedObjectKey,
  resolveEncounterPdfRender,
  resolveEvvVerificationRender,
  resolveLabResultsRender,
  resolveStatementOfDisagreement,
  retentionClassAfterWriteback,
  statementOfDisagreementPublishedEvent,
} from "../src/modules/22-documents/index";
import { assertDocLensEnabled, phase1DocLensFlag } from "../src/modules/22-documents/extraction/index";

const ORG = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";

// ── deterministic deps for the in-memory route service (pinned clock + id sequence; an echo presign port) ────
function deps() {
  let seq = 0;
  let t = 1_700_000_000_000;
  return {
    now: () => new Date((t += 1000)).toISOString(),
    newId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    // The presign port echoes the (already-clamped) ttl so the test can assert the §7.10 D11 ceiling held.
    presign: {
      async presignDownload(args: { tenantId: string; objectKey: string; downloadFilename: string; ttlSeconds: number }) {
        return { url: `https://minio.test/${args.tenantId}/${args.downloadFilename}?ttl=${args.ttlSeconds}`, expiresAt: "2026-06-22T00:05:00.000Z" };
      },
    },
  };
}

// ── §4.7 ABAC context helper (the server-assembled context a predicate evaluates against) ───────────────────
function ctx(over: Partial<AbacContext> = {}): AbacContext {
  return {
    organizationId: ORG,
    userId: USER,
    roles: ["field_clinician"],
    providerEntityIds: [],
    locationIds: [],
    attributes: {},
    ...over,
  };
}

describe("M22-T11 §12.6 workflow acceptance (W2/W5/W12/W13)", () => {
  it("W2 — a render event resolves to a plan, and the dispatch emits one `m22.document.rendered` back-ref carrying the new documentId", async () => {
    // §7.2: m6.cti.signed → select the `cti` template, mint the document, stamp the back-ref the source module reads.
    const plan = planDocumentRender("m6.cti.signed", { organizationId: ORG, patientId: PATIENT, ctiId: "cti-9" });
    expect(plan).not.toBeNull();
    expect(plan!.templateKey).toBe("cti");
    expect(plan!.aggregateId).toBe("cti-9");
    expect(plan!.scope.orgId).toBe(ORG);

    const events = await dispatchDocumentRender(plan!, {
      renderer: { async render() { return { documentId: "doc-cti-1" }; } },
    });
    expect(events).toHaveLength(1); // the routine lane emits exactly the back-ref (no critical sibling)
    expect(events[0]!.eventName).toBe("m22.document.rendered");
    expect(events[0]!.payload).toMatchObject({ documentId: "doc-cti-1", aggregateId: "cti-9", templateKey: "cti" });
  });

  it("W2 — a malformed render event (missing patientId) is dropped, never minting a key with an empty patient prefix", () => {
    // §2.2.2 — the patient-prefixed object key forbids an empty prefix; the planner drops the event (returns null).
    expect(planDocumentRender("m6.cti.signed", { organizationId: ORG, ctiId: "cti-9" })).toBeNull();
    expect(planDocumentRender("not.a.render.event", { organizationId: ORG, patientId: PATIENT })).toBeNull();
  });

  it("W5 — a DENIED amendment renders the SoD (attach_to_disclosures) and publishes the SoD-published intent; an approval skips", () => {
    const denied = resolveStatementOfDisagreement("m5.patient.amendment_decided", {
      organizationId: ORG,
      patientId: PATIENT,
      amendmentRequestId: "amend-1",
      decision: "denied",
      statementText: "The patient disputes the recorded allergy history.",
      denialReason: "The record is accurate per the attending physician.",
    });
    expect(denied.status).toBe("render");
    if (denied.status !== "render") throw new Error("unreachable");
    expect(denied.payload.attachToDisclosures).toBe(true);
    const published = statementOfDisagreementPublishedEvent(denied, "doc-sod-1");
    expect(published.eventName).toBe("m22.document.statement_of_disagreement_published");
    expect(published.payload).toMatchObject({ documentId: "doc-sod-1", originalAmendmentRequestId: "amend-1" });

    // An approved (or withdrawn) amendment is NOT a statement of disagreement — skip, no document.
    expect(
      resolveStatementOfDisagreement("m5.patient.amendment_decided", {
        organizationId: ORG,
        patientId: PATIENT,
        amendmentRequestId: "amend-2",
        decision: "approved",
      }).status,
    ).toBe("skip");
  });

  it("W12 — an EVV render carries the geo block when present and the alternate-method narrative otherwise", () => {
    const geo = resolveEvvVerificationRender("m18.evv.aggregator_accepted", {
      organizationId: ORG,
      patientId: PATIENT,
      visitId: "visit-1",
      evvRecordId: "evv-1",
      aggregatorRefId: "ref-1",
      acceptedAt: "2026-06-22T14:00:00.000Z",
      submissionId: "sub-1",
      geoVerification: { latitude: 45.5, longitude: -122.6, snapshotPresent: true },
    });
    expect(geo.status).toBe("render");
    if (geo.status !== "render") throw new Error("unreachable");
    expect(geo.aggregateId).toBe("sub-1"); // the back-ref keys on the aggregator submission id
    expect(geo.payload.geoVerified).toBe(true);
    expect(geo.payload.mapSection).not.toBeNull();
    expect(geo.payload.exceptionNarrative).toBeNull();

    const alt = resolveEvvVerificationRender("m18.evv.aggregator_accepted", {
      organizationId: ORG,
      patientId: PATIENT,
      visitId: "visit-1",
      evvRecordId: "evv-2",
      aggregatorRefId: "ref-2",
      acceptedAt: "2026-06-22T14:00:00.000Z",
      submissionId: "sub-2",
      alternateMethodReason: "Cellular signal unavailable at the rural home; caregiver attestation captured.",
    });
    if (alt.status !== "render") throw new Error("unreachable");
    expect(alt.payload.geoVerified).toBe(false);
    expect(alt.payload.mapSection).toBeNull();
    expect(alt.payload.exceptionNarrative).toContain("Cellular signal unavailable");
  });

  it("W13 — an encounter renders v1 on `signed` and a NEW version on `addendum_signed` (same document)", () => {
    const signed = resolveEncounterPdfRender("m8.encounter.signed", {
      organizationId: ORG,
      patientId: PATIENT,
      encounterId: "enc-1",
    });
    if (signed.status !== "render") throw new Error("unreachable");
    expect(signed.payload.versionReason).toBe("initial");
    expect(signed.aggregateId).toBe("enc-1");

    const addendum = resolveEncounterPdfRender("m8.encounter.addendum_signed", {
      organizationId: ORG,
      patientId: PATIENT,
      encounterId: "enc-1",
    });
    if (addendum.status !== "render") throw new Error("unreachable");
    expect(addendum.payload.versionReason).toBe("addendum");
    expect(addendum.aggregateId).toBe("enc-1"); // SAME aggregate → a new version on the same document (W2/W13)
  });
});

describe("M22-T11 §12.6 version history + signed URL (W9/W10)", () => {
  it("W9 — a re-version APPENDS to the same document; the ledger is monotonic and the active head flips to v2", () => {
    const svc = new DocumentRouteService(deps());
    const created = svc.uploadDocument(ORG, USER, {
      patientId: PATIENT,
      admissionId: null,
      retentionClass: "clinical_record",
      aggregateType: "other",
      aggregateId: null,
      title: "intake note",
      mimeType: "application/pdf",
      byteSize: 1024,
      sha256Hex: "a".repeat(64),
      patientFacing: false,
      tags: [],
    });
    expect(created.versionsCount).toBe(1);
    expect(created.activeVersion!.versionNumber).toBe(1);

    const reversioned = svc.uploadVersion(ORG, USER, created.id, {
      mimeType: "application/pdf",
      byteSize: 2048,
      sha256Hex: "b".repeat(64),
    });
    expect(reversioned.versionsCount).toBe(2);
    expect(reversioned.activeVersion!.versionNumber).toBe(2); // active head flips to the new version (F19)
    const versions = svc.listVersions(ORG, created.id);
    expect(versions.map((v) => v.versionNumber)).toEqual([1, 2]); // append-only, monotonic
    expect(versions[0]!.sha256Hex).toBe("a".repeat(64)); // v1 stays readable in history (never soft-deleted)
  });

  it("W10 — the signed URL clamps a 1h request to the 5-min non-portal ceiling and the download filename carries no PHI", async () => {
    const svc = new DocumentRouteService(deps());
    const doc = svc.uploadDocument(ORG, USER, {
      patientId: PATIENT,
      admissionId: null,
      retentionClass: "clinical_record",
      aggregateType: "encounter_pdf",
      aggregateId: "enc-1",
      title: "encounter",
      mimeType: "application/pdf",
      byteSize: 1024,
      sha256Hex: "c".repeat(64),
      patientFacing: false,
      tags: [],
    });
    const minted = await svc.mintSignedUrl(ORG, doc.id, doc.activeVersion!.id, "clinical_review", 3600);
    expect(minted.accessKind).toBe("signed_url_issued");
    expect(minted.url).toContain("ttl=300"); // §7.10 D11 — 3600 clamped to the 5-min (300s) non-portal ceiling
    expect(clampSignedUrlTtlSeconds(3600, false)).toBe(300);
    // §7.10 D11 / SEC-015 — the client-facing filename is `{type}-{shortVersionId}.pdf`, PHI-free by construction.
    expect(minted.url).not.toContain(PATIENT);
    expect(minted.url).not.toContain(doc.id);
  });

  it("W10 — the opaque filename rejects PHI tokens; the internal object key stays patient-prefixed (denylisted, never client-facing)", () => {
    // The opaque leaf accepts only an enum slug + a 12-char token — a name/MRN can never be minted into a URL.
    expect(opaqueDownloadFilename("encounter_pdf", "abc123DEF456")).toBe("encounter_pdf-abc123DEF456.pdf");
    expect(() => opaqueDownloadFilename("encounter_pdf", PATIENT)).toThrowError(
      expect.objectContaining({ code: "DOCUMENT_OBJECT_KEY_REQUIRED" }),
    );
    // The internal MinIO key IS patient-prefixed (server-internal, §3.6 denylisted) — never a client-facing string.
    expect(renderedObjectKey({ patientId: PATIENT, documentType: "encounter_pdf", documentId: "d1", versionId: "v1" })).toContain(PATIENT);
  });
});

describe("M22-T11 §12.6 HIGH-risk per-field-only (W8) + reviewer eligibility", () => {
  it("W8 — the bulk-approve predicate DENIES a review scope that contains a high-risk candidate and ALLOWS an all-low scope", async () => {
    const svc = new DocumentRouteService({
      ...deps(),
      seed: {
        reviews: [
          { id: "rev-high", organizationId: ORG, intakeBatchId: "b1", status: "in_progress", reviewerMembershipId: USER, decisions: [] },
          { id: "rev-low", organizationId: ORG, intakeBatchId: "b2", status: "in_progress", reviewerMembershipId: USER, decisions: [] },
        ],
        candidates: [
          { id: "cand-high", organizationId: ORG, reviewId: "rev-high", riskLevel: "high" },
          { id: "cand-low", organizationId: ORG, reviewId: "rev-low", riskLevel: "low" },
        ],
      },
    });
    const predicates = buildDocumentAbacPredicates({ resolver: svc });
    // §7.8 W8 — any high-risk candidate in scope → the bulk approve is denied (per-field only, D4).
    expect(await predicates.extraction_high_risk_field_per_field_only!(ctx(), { reviewId: "rev-high" })).toBe(false);
    expect(await predicates.extraction_high_risk_field_per_field_only!(ctx(), { reviewId: "rev-low" })).toBe(true);
    // Fail-closed on an incomplete / cross-tenant target.
    expect(await predicates.extraction_high_risk_field_per_field_only!(ctx(), {})).toBe(false);
    expect(await predicates.extraction_high_risk_field_per_field_only!(ctx({ organizationId: ORG_B }), { reviewId: "rev-high" })).toBe(false);
  });

  it("§4.7 D-AUTHZ-01 — only RN-or-above licensure may review a high-risk candidate; an aide is denied", async () => {
    const svc = new DocumentRouteService({
      ...deps(),
      seed: { candidates: [{ id: "cand-high", organizationId: ORG, reviewId: "rev-1", riskLevel: "high" }] },
    });
    const predicates = buildDocumentAbacPredicates({ resolver: svc });
    const rn = ctx({ attributes: { licensure: { type: "RN" } } });
    const aide = ctx({ attributes: { licensure: { type: "HHA" } } });
    expect(await predicates.extraction_reviewer_eligible!(rn, { candidateId: "cand-high" })).toBe(true);
    expect(await predicates.extraction_reviewer_eligible!(aide, { candidateId: "cand-high" })).toBe(false);
  });
});

describe("M22-T11 §12.6 cryptographic shred (W14) + tombstone read-block", () => {
  it("W14 — the eraser tombstones the non-held / non-SUD documents, SKIPS legal holds, and REFUSES SUD during the patient's lifetime", async () => {
    const candidate = (id: string, over: Partial<DocumentEraseCandidate> = {}): DocumentEraseCandidate => ({
      documentId: id,
      retentionClass: "clinical_record",
      hasActiveLegalHold: false,
      ...over,
    });
    const { store, locked } = createInMemoryDocumentEraseStore({
      candidates: [
        candidate("d1"),
        candidate("d2"),
        candidate("d3"),
        candidate("d4", { hasActiveLegalHold: true }),
        candidate("d5", { retentionClass: "compliance_42cfr_part2" }),
      ],
    });
    const first = await eraseDocumentRecord(ORG, PATIENT, store, { retentionAsOf: "2030-01-01T00:00:00.000Z" });
    expect(first.erased).toBe(3); // 3 tombstoned
    expect(first.counts.documentsTombstoned).toBe(3);
    expect(first.counts.legalHoldSkips).toBe(1); // D12 — legal hold wins, the document is preserved
    expect(first.counts.sudRefusals).toBe(1); // D23 — 42 CFR Part 2 refused during the patient's lifetime
    expect(first.counts.minioObjectsShredded).toBe(3); // version-aware object shred per destroyed doc (DR-019)
    expect(locked).toContain(PATIENT); // the per-patient advisory lock was acquired before destruction

    // Idempotent: a second erase finds nothing (the rows are already tombstoned).
    expect((await eraseDocumentRecord(ORG, PATIENT, store, {})).erased).toBe(0);
  });

  it("W14 — a tombstoned document is a hard read-block (Forbidden), preserving the row for FK integrity", () => {
    const svc = new DocumentRouteService({
      ...deps(),
      seed: { documents: [{ id: "dead", organizationId: ORG, patientId: PATIENT, status: "destroyed_tombstone" }] },
    });
    expect(() => svc.getDocument(ORG, "dead")).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("D12 — the destruction policy resolves legal-hold first, then the SUD refusal, else destroy", () => {
    expect(decideDestruction({ retentionClass: "clinical_record", hasActiveLegalHold: true }).outcome).toBe("skip_legal_hold");
    expect(decideDestruction({ retentionClass: "compliance_42cfr_part2", hasActiveLegalHold: false }).outcome).toBe("skip_compliance_42cfr_part2");
    // Legal hold wins even over a SUD document (the non-negotiable precedence, D12).
    expect(decideDestruction({ retentionClass: "compliance_42cfr_part2", hasActiveLegalHold: true }).outcome).toBe("skip_legal_hold");
    expect(decideDestruction({ retentionClass: "clinical_record", hasActiveLegalHold: false }).outcome).toBe("destroy");
  });
});

describe("M22-T11 §12.6 lab results render (W-M22-22 / W-M22-23) + §8.10 DocLens OFF", () => {
  /** A live M29 reader returning one routine + one SUD-class value (the §7.16 redaction target). */
  const liveReader = (sud: boolean): LabObservationReader => ({
    async loadObservation() {
      return {
        available: true,
        observation: {
          observationId: "obs-1",
          orderId: "order-1",
          orderingProviderName: "Dr. Smith",
          resultValues: [
            { analyteName: "Sodium", loincCode: "2951-2", value: "140", unit: "mmol/L", isSudClass: false },
            { analyteName: "Methadone", loincCode: "19357-1", value: "POSITIVE", isSudClass: sud },
          ],
        },
      };
    },
  });
  const evt = { organizationId: ORG, patientId: PATIENT, orderId: "order-1", observationId: "obs-1" };

  it("W-M22-22 — while M29 is deny-stubbed (Phase 1 / Wave H) the consumer is INERT (`awaiting_reader`): no PDF, no back-ref", async () => {
    const res = await resolveLabResultsRender("m11.order.results_received", evt, {
      labObservationReader: denyStubLabObservationReader,
    });
    expect(res.status).toBe("awaiting_reader");
  });

  it("W-M22-22 — a live reader renders the full plaintext for a non-SUD result; retention stays `clinical_record`", async () => {
    const res = await resolveLabResultsRender("m11.order.results_received", evt, { labObservationReader: liveReader(false) });
    if (res.status !== "render") throw new Error("unreachable");
    expect(res.payload.retentionClass).toBe("clinical_record");
    expect(res.payload.metadata.sudRedacted).toBe(false);
    expect(res.payload.resultValues.find((v) => v.analyteName === "Methadone")!.displayValue).toBe("POSITIVE");
  });

  it("W-M22-23 — a SUD-class value renders the redacted placeholder, upgrades retention to 42 CFR Part 2, and NEVER carries the plaintext", async () => {
    const res = await resolveLabResultsRender("m11.order.results_received", evt, { labObservationReader: liveReader(true) });
    if (res.status !== "render") throw new Error("unreachable");
    expect(res.payload.retentionClass).toBe("compliance_42cfr_part2"); // D23 — SUD upgrades retention
    expect(res.payload.metadata.sudRedacted).toBe(true);
    expect(res.payload.sudBanner).not.toBeNull();
    const sudRow = res.payload.resultValues.find((v) => v.analyteName === "Methadone")!;
    expect(sudRow.value).toBeNull(); // D20 — plaintext dropped before the engine
    expect(sudRow.displayValue).toBe(SUD_REDACTED_PLACEHOLDER);
    // §7.16 mechanical guarantee — the SUD plaintext appears NOWHERE in the render payload (binary-grep analogue).
    expect(JSON.stringify(res.payload)).not.toContain("POSITIVE");
  });

  it("W-M22-25 — the critical lane sets the D22 watermark + the `critical` flag the dispatcher uses for the second event", async () => {
    const res = await resolveLabResultsRender("m11.order.results_received_critical", evt, { labObservationReader: liveReader(false) });
    if (res.status !== "render") throw new Error("unreachable");
    expect(res.critical).toBe(true);
    expect(res.payload.watermark).not.toBeNull();
  });

  it("§8.10 — DocLens is OFF for every tenant in Phase 1; the extraction gate throws 503 EXTRACTION_DISABLED", () => {
    expect(phase1DocLensFlag.isEnabled(ORG)).toBe(false);
    expect(() => assertDocLensEnabled(phase1DocLensFlag, ORG)).toThrowError(
      expect.objectContaining({ code: "EXTRACTION_DISABLED", statusCode: 503 }),
    );
  });
});

describe("M22-T11 §12.2 retention sign-off (D9/D23) + §8.8 cross-tenant layer-independence", () => {
  it("D9 — an `intake_artifact` document auto-promotes to `clinical_record` once any extraction candidate commits", () => {
    expect(retentionClassAfterWriteback("intake_artifact", true)).toBe("clinical_record");
    expect(retentionClassAfterWriteback("intake_artifact", false)).toBe("intake_artifact"); // nothing committed → unchanged
    expect(retentionClassAfterWriteback("clinical_record", true)).toBe("clinical_record"); // only intake_artifact promotes
  });

  it("D23 — `compliance_42cfr_part2` is immutable; a downgrade is forbidden; the clinical→compliance upgrade is allowed", () => {
    expect(() => assertRetentionClassChange("clinical_record", "compliance")).not.toThrow(); // the one legal upgrade
    expect(() => assertRetentionClassChange("clinical_record", "clinical_record")).not.toThrow(); // idempotent no-op
    expect(() => assertRetentionClassChange("compliance", "clinical_record")).toThrowError(
      expect.objectContaining({ code: "DOCUMENT_RETENTION_DOWNGRADE_FORBIDDEN" }),
    );
    expect(() => assertRetentionClassChange("compliance_42cfr_part2", "clinical_record")).toThrowError(
      expect.objectContaining({ code: "DOCUMENT_SUD_RETENTION_IMMUTABLE" }),
    );
  });

  it("§8.8 — an org_a document is invisible to org_b (non-leaking NotFound; empty list); ABAC fails closed cross-tenant", async () => {
    const svc = new DocumentRouteService({
      ...deps(),
      seed: {
        documents: [{ id: "doc-a", organizationId: ORG, patientId: PATIENT }],
        caseload: [`${USER}|${PATIENT}`],
      },
    });
    // Org A reads its own document; Org B is denied with a non-leaking NotFound and an empty list.
    expect(svc.getDocument(ORG, "doc-a").id).toBe("doc-a");
    expect(() => svc.getDocument(ORG_B, "doc-a")).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(svc.listDocuments(ORG_B, {}).items).toEqual([]);

    // §4.7 document_owner_or_caseload — the caseload member passes; a cross-tenant caller fails closed.
    const predicates = buildDocumentAbacPredicates({ resolver: svc });
    expect(await predicates.document_owner_or_caseload!(ctx(), { documentId: "doc-a" })).toBe(true);
    expect(await predicates.document_owner_or_caseload!(ctx({ organizationId: ORG_B }), { documentId: "doc-a" })).toBe(false);
    // A non-caseload clinician in the SAME org is denied (caseload scoping holds within the tenant).
    expect(await predicates.document_owner_or_caseload!(ctx({ userId: "stranger" }), { documentId: "doc-a" })).toBe(false);
  });
});

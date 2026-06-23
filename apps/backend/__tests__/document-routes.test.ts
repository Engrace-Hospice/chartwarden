// apps/backend/__tests__/document-routes.test.ts — M22-T07.
//
// Proves the §4.1 route backend (`DocumentRouteService`) + the seven §4.7 ABAC predicate resolvers M22 owns.
// Exercises the in-memory slice directly (the Drizzle prod path leans on RLS for the same org-pinning guarantee):
// the §2.2.1 upload/version machine, opaque cursor pagination (SD-052), the §7.10 D11 signed-URL TTL clamp, and
// each ABAC predicate's allow/deny path against a seeded dataset. No HTTP — the route handlers are thin parsers
// over these methods (the full request-level pass lands in M22-T11).
import type { AbacContext } from "@wardenx/auth";
import { describe, expect, it } from "vitest";
import {
  type DocumentAbacResolver,
  buildDocumentAbacPredicates,
} from "../src/modules/22-documents/abac-predicates";
import { DocumentRouteService, type InternalPresignPort } from "../src/modules/22-documents/routes/service";

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PAT = "44444444-4444-4444-4444-444444444444";

let seq = 0;
const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const clock = (() => {
  let t = 1_700_000_000_000;
  return () => new Date((t += 1000)).toISOString();
})();

const fakePresign: InternalPresignPort = {
  async presignDownload({ objectKey, ttlSeconds }) {
    return { url: `https://store.local/${objectKey}?ttl=${ttlSeconds}`, expiresAt: new Date(0).toISOString() };
  },
};

function svc(seed?: ConstructorParameters<typeof DocumentRouteService>[0]["seed"]): DocumentRouteService {
  seq = 0;
  return new DocumentRouteService({ now: clock, newId, presign: fakePresign, seed });
}

const ctx = (over: Partial<AbacContext> = {}): AbacContext => ({
  organizationId: ORG,
  userId: USER,
  roles: [],
  providerEntityIds: [],
  locationIds: [],
  attributes: {},
  ...over,
});

const upload = (s: DocumentRouteService, over: Partial<Parameters<DocumentRouteService["uploadDocument"]>[2]> = {}) =>
  s.uploadDocument(ORG, USER, {
    patientId: PAT,
    admissionId: null,
    retentionClass: "clinical_record",
    aggregateType: "encounter",
    aggregateId: null,
    title: "Visit note",
    mimeType: "application/pdf",
    byteSize: 100,
    sha256Hex: "a".repeat(64),
    patientFacing: false,
    tags: [],
    ...over,
  });

describe("M22-T07 — DocumentRouteService (§4.1)", () => {
  it("uploads a document at v1 then appends a monotonic v2", () => {
    const s = svc();
    const doc = upload(s);
    expect(doc.status).toBe("active");
    expect(doc.activeVersion?.versionNumber).toBe(1);
    const v2 = s.uploadVersion(ORG, USER, doc.id, { mimeType: "application/pdf", byteSize: 120, sha256Hex: "b".repeat(64) });
    expect(v2.versionsCount).toBe(2);
    expect(v2.activeVersion?.versionNumber).toBe(2);
  });

  it("is org-pinned: a cross-tenant fetch is not found", () => {
    const s = svc();
    const doc = upload(s);
    expect(() => s.getDocument(OTHER, doc.id)).toThrow();
  });

  it("paginates with an opaque cursor (newest first, no overlap, exact has_more)", () => {
    const s = svc();
    for (let i = 0; i < 5; i++) upload(s, { title: `doc ${i}` });
    const page1 = s.listDocuments(ORG, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = s.listDocuments(ORG, { limit: 2, cursor: page1.nextCursor ?? undefined });
    expect(page2.items).toHaveLength(2);
    // no id appears on both pages
    const ids = new Set(page1.items.map((d) => d.id));
    expect(page2.items.every((d) => !ids.has(d.id))).toBe(true);
    const page3 = s.listDocuments(ORG, { limit: 2, cursor: page2.nextCursor ?? undefined });
    expect(page3.items).toHaveLength(1);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextCursor).toBeNull();
  });

  it("mints a signed URL clamped to the §7.10 D11 non-portal 5-minute ceiling", async () => {
    const s = svc();
    const doc = upload(s);
    const versionId = doc.activeVersion?.id as string;
    const minted = await s.mintSignedUrl(ORG, doc.id, versionId, "treatment", 3600);
    expect(minted.accessKind).toBe("signed_url_issued");
    expect(minted.url).toContain("ttl=300"); // 3600 requested → clamped to 300s
  });
});

describe("M22-T07 — §4.7 ABAC predicate resolvers", () => {
  function predicates(resolver: DocumentAbacResolver) {
    return buildDocumentAbacPredicates({ resolver });
  }

  it("document_owner_or_caseload: caseload member allowed, stranger denied, scope-bypass + org-level allowed", async () => {
    const s = svc({ documents: [{ id: "d-pat", organizationId: ORG, patientId: PAT }, { id: "d-org", organizationId: ORG, patientId: null }], caseload: [`${USER}|${PAT}`] });
    const p = predicates(s).document_owner_or_caseload;
    expect(await p(ctx(), { documentId: "d-pat" })).toBe(true); // in caseload
    expect(await p(ctx({ userId: "stranger" }), { documentId: "d-pat" })).toBe(false); // not in caseload
    expect(await p(ctx({ roles: ["compliance_officer"], userId: "stranger" }), { documentId: "d-pat" })).toBe(true); // scope-bypass
    expect(await p(ctx({ userId: "stranger" }), { documentId: "d-org" })).toBe(true); // org-level doc
    expect(await p(ctx(), { documentId: "missing" })).toBe(false); // absent → fail closed
    expect(await p(ctx(), {})).toBe(false); // incomplete target → fail closed
  });

  it("legal_hold_aware: denies a mutating action when an active hold exists", async () => {
    const s = svc({ documents: [{ id: "d1", organizationId: ORG, patientId: PAT }], legalHolds: [{ organizationId: ORG, documentId: "d1", active: true }] });
    const p = predicates(s).legal_hold_aware;
    expect(await p(ctx(), { documentId: "d1" })).toBe(false);
    expect(await p(ctx(), { documentId: "no-hold" })).toBe(true);
  });

  it("extraction_reviewer_eligible: high-risk needs RN-or-above licensure; low-risk allows intake_nurse", async () => {
    const s = svc({
      candidates: [
        { id: "c-high", organizationId: ORG, reviewId: "rv", riskLevel: "high" },
        { id: "c-low", organizationId: ORG, reviewId: "rv", riskLevel: "low" },
        { id: "c-med", organizationId: ORG, reviewId: "rv", riskLevel: "medium" },
      ],
    });
    const p = predicates(s).extraction_reviewer_eligible;
    expect(await p(ctx({ attributes: { licensure: { type: "RN" } } }), { candidateId: "c-high" })).toBe(true);
    expect(await p(ctx({ attributes: { licensure: { type: "LPN" } } }), { candidateId: "c-high" })).toBe(false);
    expect(await p(ctx({ attributes: { licensure: { type: "LPN" } } }), { candidateId: "c-med" })).toBe(true);
    expect(await p(ctx({ roles: ["intake_nurse"] }), { candidateId: "c-low" })).toBe(true);
    expect(await p(ctx(), { candidateId: "c-low" })).toBe(false); // no licensure + no intake role → deny
  });

  it("extraction_high_risk_field_per_field_only: denies bulk-approve when scope holds a high-risk candidate", async () => {
    const s = svc({
      reviews: [{ id: "rv-hi", organizationId: ORG, intakeBatchId: "b", status: "in_progress", reviewerMembershipId: USER, decisions: [] }, { id: "rv-lo", organizationId: ORG, intakeBatchId: "b", status: "in_progress", reviewerMembershipId: USER, decisions: [] }],
      candidates: [{ id: "c1", organizationId: ORG, reviewId: "rv-hi", riskLevel: "high" }, { id: "c2", organizationId: ORG, reviewId: "rv-lo", riskLevel: "low" }],
    });
    const p = predicates(s).extraction_high_risk_field_per_field_only;
    expect(await p(ctx(), { reviewId: "rv-hi" })).toBe(false);
    expect(await p(ctx(), { reviewId: "rv-lo" })).toBe(true);
    expect(await p(ctx(), { reviewId: "missing" })).toBe(false); // absent → fail closed
  });

  it("publish + overlay authority: platform_admin publishes; org_admin overlay needs fresh step-up", async () => {
    const s = svc();
    const pub = predicates(s).form_template_publish_authority;
    expect(await pub(ctx({ roles: ["platform_admin"] }), {})).toBe(true);
    expect(await pub(ctx({ roles: ["org_admin"] }), {})).toBe(false);
    const overlay = predicates(s).tenant_template_overlay_edit_authority;
    expect(await overlay(ctx({ roles: ["org_admin"] }), { stepUpFresh: true })).toBe(true);
    expect(await overlay(ctx({ roles: ["org_admin"] }), { stepUpFresh: false })).toBe(false); // stale step-up → deny
    expect(await overlay(ctx({ roles: ["clinical_admin"] }), { stepUpFresh: true })).toBe(false); // not org_admin → deny
  });

  it("document_within_admission_window: post-discharge readable inside window; out-of-window only scope-bypass", async () => {
    const s = svc({
      documents: [{ id: "d-in", organizationId: ORG, patientId: PAT }, { id: "d-out", organizationId: ORG, patientId: PAT }, { id: "d-cur", organizationId: ORG, patientId: PAT }],
      admissionWindows: [
        { organizationId: ORG, documentId: "d-in", postDischarge: true, withinWindow: true },
        { organizationId: ORG, documentId: "d-out", postDischarge: true, withinWindow: false },
      ],
    });
    const p = predicates(s).document_within_admission_window;
    expect(await p(ctx(), { documentId: "d-in" })).toBe(true); // within 13-month window
    expect(await p(ctx(), { documentId: "d-out" })).toBe(false); // out of window, no bypass role
    expect(await p(ctx({ roles: ["qa"] }), { documentId: "d-out" })).toBe(true); // scope-bypass always reads
    expect(await p(ctx(), { documentId: "d-cur" })).toBe(true); // no window fact → not post-discharge → pass
  });
});

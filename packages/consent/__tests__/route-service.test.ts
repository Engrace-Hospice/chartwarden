// M39-T07 — ConsentRouteService slice (create-draft → sign → revoke; cursor pagination §4.12).
import { describe, expect, it } from "vitest";
import { type EvalAuditRow, createInMemoryConsentRouteService } from "../src/routes/service";

const ORG = "org-1";
const PAT = "pat-1";

describe("ConsentRouteService lifecycle (§2.2.1 over the route slice)", () => {
  it("create draft → sign → revoke walks the status machine", () => {
    const { service } = createInMemoryConsentRouteService();
    const draft = service.createDraft(ORG, {
      patientId: PAT,
      typeKey: "hipaa_release",
      grantorKind: "patient_self",
      captureMethod: "typed_signature_in_app",
      scopeDescriptor: {},
      createdById: "u1",
    });
    expect(draft.status).toBe("draft");

    const signed = service.signConsent(ORG, draft.id, "u1", new Date().toISOString());
    expect(signed.status).toBe("active");
    expect(service.listConsentsForPatient(ORG, PAT).map((r) => r.id)).toContain(draft.id);

    const revoked = service.revokeConsent(
      ORG,
      draft.id,
      { actorIsStaff: true, revokedByKind: "staff", reasonText: "x".repeat(40), evidenceDocumentId: "d1", revokedById: "u1" },
      new Date().toISOString(),
    );
    expect(revoked.status).toBe("revoked");
    // a revoked consent no longer appears in the active list
    expect(service.listConsentsForPatient(ORG, PAT)).toHaveLength(0);
  });

  it("staff revocation without a ≥40-char reason is a validation refusal", () => {
    const { service } = createInMemoryConsentRouteService();
    const d = service.createDraft(ORG, {
      patientId: PAT,
      typeKey: "hipaa_release",
      grantorKind: "patient_self",
      captureMethod: "typed_signature_in_app",
      scopeDescriptor: {},
      createdById: "u1",
    });
    service.signConsent(ORG, d.id, "u1", new Date().toISOString());
    expect(() =>
      service.revokeConsent(
        ORG,
        d.id,
        { actorIsStaff: true, revokedByKind: "staff", reasonText: "too short", evidenceDocumentId: "d1", revokedById: "u1" },
        new Date().toISOString(),
      ),
    ).toThrow();
  });

  it("signing a non-draft is an invalid transition", () => {
    const { service } = createInMemoryConsentRouteService();
    const d = service.createDraft(ORG, {
      patientId: PAT,
      typeKey: "portal_access",
      grantorKind: "patient_self",
      captureMethod: "electronic_portal_signature",
      scopeDescriptor: {},
      createdById: "u1",
    });
    service.signConsent(ORG, d.id, "u1", new Date().toISOString());
    expect(() => service.signConsent(ORG, d.id, "u1", new Date().toISOString())).toThrow();
  });
});

describe("§4.12 cursor pagination", () => {
  function rows(): EvalAuditRow[] {
    return [1, 2, 3, 4, 5].map((n) => ({
      id: `ea-${n}`,
      organizationId: ORG,
      patientId: PAT,
      consentRecordId: "c-1",
      typeKey: "42_cfr_part_2_release",
      allowed: true,
      denyReason: null,
      callerModule: "m28",
      evaluatedAt: `2026-06-0${n}T00:00:00.000Z`,
    }));
  }

  it("pages newest-first with an opaque cursor and no overlap", () => {
    const { service } = createInMemoryConsentRouteService({ evalAudit: rows() });
    const p1 = service.listEvalAudit(ORG, { patientId: PAT }, { pageSize: 2 });
    expect(p1.rows.map((r) => r.id)).toEqual(["ea-5", "ea-4"]);
    expect(p1.nextCursor).toBeTypeOf("string");

    const p2 = service.listEvalAudit(ORG, { patientId: PAT }, { cursor: p1.nextCursor!, pageSize: 2 });
    expect(p2.rows.map((r) => r.id)).toEqual(["ea-3", "ea-2"]);

    const p3 = service.listEvalAudit(ORG, { patientId: PAT }, { cursor: p2.nextCursor!, pageSize: 2 });
    expect(p3.rows.map((r) => r.id)).toEqual(["ea-1"]);
    expect(p3.nextCursor).toBeNull();
  });

  it("the cursor is opaque (base64), not an offset integer", () => {
    const { service } = createInMemoryConsentRouteService({ evalAudit: rows() });
    const p1 = service.listEvalAudit(ORG, {}, { pageSize: 1 });
    expect(p1.nextCursor).not.toMatch(/^\d+$/);
  });
});

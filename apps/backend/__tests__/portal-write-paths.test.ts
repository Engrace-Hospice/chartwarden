// apps/backend/__tests__/portal-write-paths.test.ts — M31-T06 write-path domain-core tests.
//
// Covers the three PURE clinical-record write surfaces (§7.7–§7.9) + the resolver that closes M13's deny-stub:
//   • caregiver-attested administration (§7.7 / M13 D10) — the ±2h window, attestation checkbox, relationship,
//     order-active, and discharge-read-only guards, and the validated M13 payload.
//   • the M31 caregiver portal-session resolver (§7.7) — bound-patient resolution + fail-closed denies.
//   • document upload → M22 intake (§7.8) — size, MIME allowlist, magic-byte re-check, tenant tighten.
//   • amendment request → M5 §164.526 (§7.9) — target/change validation + the submit payload.
// No IO — every fact is injected; `nowMs` is a fixed literal.
import { describe, expect, it } from "vitest";
import {
  CAREGIVER_ATTESTED_ACTOR_SENTINEL,
  CAREGIVER_ATTEST_WINDOW_MS,
  PORTAL_UPLOAD_MAX_BYTES,
  PortalWriteError,
  createInMemoryCaregiverSessionPort,
  createPortalCaregiverSessionResolver,
  magicBytesMatch,
  planAmendmentRequest,
  planCaregiverAttestation,
  planDocumentUpload,
  sanitizedRejectionReason,
  type CaregiverAttestationInput,
} from "../src/modules/31-portal/write-paths/index";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");

function baseAttestation(over: Partial<CaregiverAttestationInput> = {}): CaregiverAttestationInput {
  return {
    orgId: "org-1",
    patientId: "pat-1",
    medicationOrderId: "ord-1",
    orderActive: true,
    attestingRelationship: "primary_caregiver",
    patientDischargedReadOnly: false,
    administeredAtMs: NOW,
    attestationChecked: true,
    portalAccountId: "acct-1",
    ...over,
  };
}

describe("§7.7 caregiver-attested administration", () => {
  it("produces a validated M13 payload on the happy path", () => {
    const p = planCaregiverAttestation(baseAttestation({ note: "  gave with food  " }), NOW);
    expect(p.patientId).toBe("pat-1");
    expect(p.medicationOrderId).toBe("ord-1");
    expect(p.attestingRelationship).toBe("primary_caregiver");
    expect(p.administeredAtIso).toBe("2026-08-02T12:00:00.000Z");
    expect(p.note).toBe("gave with food"); // trimmed
  });

  it("accepts a dose exactly at the ±2h boundary and rejects just beyond it", () => {
    expect(() =>
      planCaregiverAttestation(
        baseAttestation({ administeredAtMs: NOW - CAREGIVER_ATTEST_WINDOW_MS }),
        NOW,
      ),
    ).not.toThrow();
    expectCode(
      () =>
        planCaregiverAttestation(
          baseAttestation({ administeredAtMs: NOW - CAREGIVER_ATTEST_WINDOW_MS - 1 }),
          NOW,
        ),
      "DOSE_TIME_OUT_OF_RANGE",
    );
  });

  it("tightens the window when the tenant passes a smaller one (never loosens)", () => {
    const tight = 30 * 60 * 1000; // 30 min
    expectCode(
      () => planCaregiverAttestation(baseAttestation({ administeredAtMs: NOW - 40 * 60 * 1000 }), NOW, tight),
      "DOSE_TIME_OUT_OF_RANGE",
    );
    // A tenant "window" larger than the floor is clamped down to the 2h floor — still rejects at +3h.
    expectCode(
      () =>
        planCaregiverAttestation(
          baseAttestation({ administeredAtMs: NOW - 3 * 60 * 60 * 1000 }),
          NOW,
          10 * 60 * 60 * 1000,
        ),
      "DOSE_TIME_OUT_OF_RANGE",
    );
  });

  it("refuses a missing attestation checkbox", () => {
    expectCode(() => planCaregiverAttestation(baseAttestation({ attestationChecked: false }), NOW), "ATTESTATION_ABSENT");
  });

  it("refuses a caller who is neither primary caregiver nor DPOA (403)", () => {
    expectCode(
      () => planCaregiverAttestation(baseAttestation({ attestingRelationship: null }), NOW),
      "ATTESTATION_RELATIONSHIP_FORBIDDEN",
    );
  });

  it("refuses an inactive order (410 Gone)", () => {
    const err = expectCode(() => planCaregiverAttestation(baseAttestation({ orderActive: false }), NOW), "ORDER_INACTIVE");
    expect(err.statusCode).toBe(410);
  });

  it("refuses every write while the patient is in the post-discharge read-only grace", () => {
    expectCode(
      () => planCaregiverAttestation(baseAttestation({ patientDischargedReadOnly: true }), NOW),
      "PATIENT_DISCHARGED_READ_ONLY",
    );
  });

  it("exposes a non-empty caregiver-attested actor sentinel", () => {
    expect(CAREGIVER_ATTESTED_ACTOR_SENTINEL.length).toBeGreaterThan(0);
  });
});

describe("§7.7 caregiver portal-session resolver (closes M13 deny-stub)", () => {
  const port = createInMemoryCaregiverSessionPort([
    {
      organizationId: "org-1",
      caregiverSessionId: "sess-ok",
      portalAccountId: "acct-1",
      activePatientId: "pat-1",
      accountActive: true,
      grantActive: true,
      caregiverDisplayName: "Jordan Rivera",
    },
    {
      organizationId: "org-1",
      caregiverSessionId: "sess-suspended",
      portalAccountId: "acct-2",
      activePatientId: "pat-2",
      accountActive: false,
      grantActive: true,
      caregiverDisplayName: "Sam Lee",
    },
    {
      organizationId: "org-1",
      caregiverSessionId: "sess-nogrant",
      portalAccountId: "acct-3",
      activePatientId: "pat-3",
      accountActive: true,
      grantActive: false,
      caregiverDisplayName: "Alex Kim",
    },
  ]);
  const resolver = createPortalCaregiverSessionResolver(port);

  it("resolves an active session to its bound patient", async () => {
    const r = await resolver.resolve("org-1", "sess-ok");
    expect(r).toEqual({ bound: true, patientId: "pat-1", caregiverDisplayName: "Jordan Rivera" });
  });

  it("fails closed on an unknown session", async () => {
    expect(await resolver.resolve("org-1", "nope")).toEqual({ bound: false, reason: "SESSION_NOT_FOUND" });
  });

  it("fails closed on a suspended/revoked account", async () => {
    expect(await resolver.resolve("org-1", "sess-suspended")).toEqual({
      bound: false,
      reason: "SESSION_NOT_ACTIVE",
    });
  });

  it("fails closed when no active grant backs the bound patient", async () => {
    expect(await resolver.resolve("org-1", "sess-nogrant")).toEqual({
      bound: false,
      reason: "GRANT_NOT_ACTIVE",
    });
  });

  it("rejects a body whose claimed patient differs from the session's bound patient", async () => {
    expect(await resolver.resolveForPatient("org-1", "sess-ok", "pat-999")).toEqual({
      bound: false,
      reason: "PATIENT_MISMATCH",
    });
    expect(await resolver.resolveForPatient("org-1", "sess-ok", "pat-1")).toMatchObject({ bound: true });
  });

  it("does not leak across tenants", async () => {
    expect(await resolver.resolve("org-2", "sess-ok")).toEqual({ bound: false, reason: "SESSION_NOT_FOUND" });
  });
});

describe("§7.8 document upload → M22 intake", () => {
  const pdfMagic = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31];

  it("accepts a valid PDF and plans the two outbox events", () => {
    const plan = planDocumentUpload({
      orgId: "org-1",
      patientId: "pat-1",
      portalAccountId: "acct-1",
      byteSize: 12 * 1024 * 1024,
      declaredMime: "application/pdf",
      magicBytes: pdfMagic,
      patientDischargedReadOnly: false,
    });
    expect(plan.mime).toBe("application/pdf");
    expect(plan.startedEvent).toBe("m31.portal_document.upload_started");
    expect(plan.uploadedEvent).toBe("m31.portal_document.uploaded");
  });

  it("rejects a file over the platform floor (413)", () => {
    const err = expectCode(
      () =>
        planDocumentUpload({
          orgId: "org-1",
          patientId: "pat-1",
          portalAccountId: "acct-1",
          byteSize: PORTAL_UPLOAD_MAX_BYTES + 1,
          declaredMime: "application/pdf",
          magicBytes: pdfMagic,
          patientDischargedReadOnly: false,
        }),
      "UPLOAD_TOO_LARGE",
    );
    expect(err.statusCode).toBe(413);
  });

  it("honours a tenant-tightened size cap", () => {
    expectCode(
      () =>
        planDocumentUpload({
          orgId: "org-1",
          patientId: "pat-1",
          portalAccountId: "acct-1",
          byteSize: 6 * 1024 * 1024,
          declaredMime: "application/pdf",
          magicBytes: pdfMagic,
          patientDischargedReadOnly: false,
          tenantMaxBytes: 5 * 1024 * 1024,
        }),
      "UPLOAD_TOO_LARGE",
    );
  });

  it("rejects a MIME outside the allowlist (415)", () => {
    const err = expectCode(
      () =>
        planDocumentUpload({
          orgId: "org-1",
          patientId: "pat-1",
          portalAccountId: "acct-1",
          byteSize: 1024,
          declaredMime: "application/zip",
          magicBytes: [0x50, 0x4b, 0x03, 0x04],
          patientDischargedReadOnly: false,
        }),
      "UPLOAD_MIME_NOT_ALLOWED",
    );
    expect(err.statusCode).toBe(415);
  });

  it("rejects a content-type spoof (magic bytes do not match declared MIME)", () => {
    expectCode(
      () =>
        planDocumentUpload({
          orgId: "org-1",
          patientId: "pat-1",
          portalAccountId: "acct-1",
          byteSize: 1024,
          declaredMime: "application/pdf",
          magicBytes: [0x4d, 0x5a, 0x90, 0x00], // MZ (a PE executable)
          patientDischargedReadOnly: false,
        }),
      "UPLOAD_MAGIC_BYTE_MISMATCH",
    );
  });

  it("matches HEIC by its ftyp box within the first 12 bytes", () => {
    const heic = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63];
    expect(magicBytesMatch("image/heic", heic)).toBe(true);
    expect(magicBytesMatch("image/heic", [0x00, 0x00, 0x00, 0x18, 0x6d, 0x6f, 0x6f, 0x76])).toBe(false);
  });

  it("refuses uploads while discharged-read-only", () => {
    expectCode(
      () =>
        planDocumentUpload({
          orgId: "org-1",
          patientId: "pat-1",
          portalAccountId: "acct-1",
          byteSize: 1024,
          declaredMime: "application/pdf",
          magicBytes: pdfMagic,
          patientDischargedReadOnly: true,
        }),
      "PATIENT_DISCHARGED_READ_ONLY",
    );
  });

  it("sanitizes rejection reasons (never leaks internal detail)", () => {
    expect(sanitizedRejectionReason("UPLOAD_TOO_LARGE")).toBe("size_limit");
    expect(sanitizedRejectionReason("UPLOAD_MIME_NOT_ALLOWED")).toBe("mime_not_allowed");
    expect(sanitizedRejectionReason("UPLOAD_MAGIC_BYTE_MISMATCH")).toBe("mime_not_allowed");
    expect(sanitizedRejectionReason("m22_intake_failed")).toBe("m22_intake_failed");
  });
});

describe("§7.9 amendment request → M5 §164.526", () => {
  it("produces a source='portal' submission payload", () => {
    const p = planAmendmentRequest({
      orgId: "org-1",
      patientId: "pat-1",
      portalAccountId: "acct-1",
      targetKind: "patient_demographic",
      targetRef: "dateOfBirth",
      requestedChange: "  Date of birth should be 1942-03-15  ",
      patientDischargedReadOnly: false,
    });
    expect(p.source).toBe("portal");
    expect(p.originatingPortalAccountId).toBe("acct-1");
    expect(p.requestedChange).toBe("Date of birth should be 1942-03-15"); // trimmed
    expect(p.submittedEvent).toBe("m31.portal_amendment_request.submitted");
  });

  it("refuses an empty target or change", () => {
    expectCode(
      () =>
        planAmendmentRequest({
          orgId: "org-1",
          patientId: "pat-1",
          portalAccountId: "acct-1",
          targetKind: "encounter_narrative",
          targetRef: "  ",
          requestedChange: "something",
          patientDischargedReadOnly: false,
        }),
      "AMENDMENT_TARGET_INVALID",
    );
    expectCode(
      () =>
        planAmendmentRequest({
          orgId: "org-1",
          patientId: "pat-1",
          portalAccountId: "acct-1",
          targetKind: "patient_demographic",
          targetRef: "dateOfBirth",
          requestedChange: "   ",
          patientDischargedReadOnly: false,
        }),
      "AMENDMENT_TARGET_INVALID",
    );
  });

  it("refuses amendment while discharged-read-only", () => {
    expectCode(
      () =>
        planAmendmentRequest({
          orgId: "org-1",
          patientId: "pat-1",
          portalAccountId: "acct-1",
          targetKind: "patient_demographic",
          targetRef: "dateOfBirth",
          requestedChange: "correction",
          patientDischargedReadOnly: true,
        }),
      "PATIENT_DISCHARGED_READ_ONLY",
    );
  });
});

/** Assert a thunk throws a {@link PortalWriteError} with the exact code; returns it for further assertions. */
function expectCode(fn: () => unknown, code: string): PortalWriteError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PortalWriteError);
    expect((e as PortalWriteError).code).toBe(code);
    return e as PortalWriteError;
  }
  throw new Error(`expected PortalWriteError(${code}) but nothing was thrown`);
}

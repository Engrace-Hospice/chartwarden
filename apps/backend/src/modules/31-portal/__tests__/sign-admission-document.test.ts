import { describe, expect, it } from "vitest";
import {
  type AdmissionDocumentSigners,
  type ConsentStatusReader,
  type PortalSignerContext,
  type SignatureRequestRecord,
  type SignatureRequestStore,
  type SignerStatement,
  consentGrantorKindFor,
  signAdmissionDocument,
} from "../write-paths/sign-admission-document";

const ORG = "00000000-0000-4000-8000-000000000001";
const PATIENT = "00000000-0000-4000-8000-0000000000a1";
const REQ = "00000000-0000-4000-8000-0000000000b1";
const DPOA = "00000000-0000-4000-8000-0000000000c1";

const statement: SignerStatement = {
  signedTypedName: "Pat Example",
  signerRelationshipText: "Daughter and healthcare agent",
  patientUnableReason: "Patient is too weak to hold a pen",
  attestationSha256: "a".repeat(64),
  idempotencyKey: "idem-1",
};
const signerOf = (grantKind: PortalSignerContext["grantKind"]): PortalSignerContext => ({
  portalUserId: "00000000-0000-4000-8000-0000000000e1",
  portalAccountId: "00000000-0000-4000-8000-0000000000d1",
  portalSessionId: "sess-1",
  grantKind,
  sourceConsentRecordId: DPOA,
});

function harness(
  req: Partial<SignatureRequestRecord> = {},
  opts: {
    dpoa?: { patientId: string; typeKey: string; status: string } | null;
    allowUnreviewed?: boolean;
  } = {},
) {
  let record: SignatureRequestRecord = {
    id: REQ,
    patientId: PATIENT,
    docKind: "hipaa_npp_acknowledgement",
    status: "pending",
    targetRef: null,
    templateVersion: "1.0.0",
    ...req,
  };
  const calls: string[] = [];
  let failMarkOnce = false;
  const requests: SignatureRequestStore = {
    get: async () => record,
    markSigned: async (_o, _id, input) => {
      if (failMarkOnce) {
        failMarkOnce = false;
        throw new Error("db down");
      }
      calls.push("markSigned");
      record = { ...record, status: "signed", targetRef: input.targetRef };
      return record;
    },
  };
  // Idempotent like the real adapters: the first call "signs", later calls report the same record.
  const signedDocs = new Map<string, string>();
  const once = (key: string, call: string) => {
    calls.push(call);
    if (!signedDocs.has(key)) signedDocs.set(key, `rec-${signedDocs.size + 1}`);
    return { recordId: signedDocs.get(key) as string };
  };
  const signers: AdmissionDocumentSigners = {
    election: async (i) => once(`es:${i.electionStatementId}`, "election"),
    noticeOfRights: async (i) => once(`nor:${i.admissionId}`, "nor"),
    consent: async (i) =>
      once(`c:${i.typeKey}`, `consent:${i.grantorKind}:${i.actingConsentId ?? "-"}`),
  };
  const consents: ConsentStatusReader = {
    read: async () =>
      opts.dpoa === undefined
        ? { patientId: PATIENT, typeKey: "dpoa_healthcare", status: "active" }
        : opts.dpoa,
  };
  const deps = {
    requests,
    signers,
    consents,
    allowUnreviewedTemplates: opts.allowUnreviewed ?? false,
  };
  return {
    deps,
    calls,
    failMarkOnce: () => {
      failMarkOnce = true;
    },
    current: () => record,
  };
}

const sign = (h: ReturnType<typeof harness>, grant: PortalSignerContext["grantKind"]) =>
  signAdmissionDocument(h.deps, {
    organizationId: ORG,
    requestId: REQ,
    signer: signerOf(grant),
    statement,
  });

describe("signAdmissionDocument", () => {
  it("signs an M39 document and records the consent id on the request", async () => {
    const h = harness();
    const r = await sign(h, "patient_self");
    expect(r).toMatchObject({ ok: true, alreadySigned: false });
    expect(h.current()).toMatchObject({ status: "signed", targetRef: "rec-1" });
    expect(h.calls).toEqual(["consent:patient_self:-", "markSigned"]);
  });

  it("routes the election to M06 with the portal method, using the staff-drafted target", async () => {
    const h = harness(
      { docKind: "election_statement", targetRef: "es-1" },
      { allowUnreviewed: true },
    );
    expect(await sign(h, "dpoa_healthcare")).toMatchObject({ ok: true });
    expect(h.calls).toEqual(["election", "markSigned"]);
  });

  it("denies an M06 document whose staff-drafted target is missing", async () => {
    const h = harness(
      { docKind: "notice_of_patient_rights", targetRef: null },
      { allowUnreviewed: true },
    );
    expect(await sign(h, "patient_self")).toEqual({ ok: false, code: "request_target_missing" });
    expect(h.calls).toEqual([]);
  });

  it("refuses an M06 document while its current wording is a draft, even for an older approved-looking version", async () => {
    for (const docKind of ["election_statement", "notice_of_patient_rights"] as const) {
      const h = harness({ docKind, targetRef: "es-1", templateVersion: "1.0.0" });
      expect(await sign(h, "patient_self")).toEqual({
        ok: false,
        code: "template_pending_legal_review",
      });
      expect(h.calls).toEqual([]);
    }
  });

  it("retry after a crash between M39 and the request update links the same consent, signing once", async () => {
    const h = harness();
    h.failMarkOnce();
    await expect(sign(h, "patient_self")).rejects.toThrow("db down");
    expect(h.current().status).toBe("pending");
    expect(await sign(h, "patient_self")).toMatchObject({ ok: true });
    expect(h.current()).toMatchObject({ status: "signed", targetRef: "rec-1" });
  });

  it("returns an already-signed request without calling any signer", async () => {
    const h = harness({ status: "signed", targetRef: "rec-9" });
    expect(await sign(h, "patient_self")).toMatchObject({ ok: true, alreadySigned: true });
    expect(h.calls).toEqual([]);
  });

  it("denies a caregiver the election and a voided request", async () => {
    const election = harness({ docKind: "election_statement", targetRef: "es-1" });
    expect(await sign(election, "family_caregiver")).toEqual({
      ok: false,
      code: "not_authorized_for_document",
    });
    expect(await sign(harness({ status: "voided" }), "patient_self")).toEqual({
      ok: false,
      code: "request_not_open",
    });
  });

  it("requires a caregiver to say why the patient did not sign", async () => {
    const h = harness();
    const r = await signAdmissionDocument(h.deps, {
      organizationId: ORG,
      requestId: REQ,
      signer: signerOf("family_caregiver"),
      statement: { ...statement, patientUnableReason: " " },
    });
    expect(r).toEqual({ ok: false, code: "patient_unable_reason_required" });
  });

  it("requires a live healthcare DPOA of THIS patient behind a healthcare agent's grant", async () => {
    for (const dpoa of [
      null,
      { patientId: PATIENT, typeKey: "dpoa_healthcare", status: "revoked" },
      { patientId: "other-patient", typeKey: "dpoa_healthcare", status: "active" },
      { patientId: PATIENT, typeKey: "dpoa_financial", status: "active" },
    ]) {
      const h = harness({}, { dpoa });
      expect(await sign(h, "dpoa_healthcare")).toEqual({
        ok: false,
        code: "dpoa_consent_not_active",
      });
      expect(h.calls).toEqual([]);
    }
  });

  it("cites the DPOA consent as the acting consent for an agent's M39 signature", async () => {
    const h = harness();
    await sign(h, "dpoa_healthcare");
    expect(h.calls[0]).toBe(`consent:dpoa_healthcare_agent:${DPOA}`);
  });

  it("blocks a pending-legal-review template unless the tenant allows it", async () => {
    const pending = {
      docKind: "consent_to_treat" as const,
      templateVersion: "0.0.0-pending-legal-review",
    };
    expect(await sign(harness(pending), "patient_self")).toEqual({
      ok: false,
      code: "template_pending_legal_review",
    });
    expect(await sign(harness(pending, { allowUnreviewed: true }), "patient_self")).toMatchObject({
      ok: true,
    });
  });

  it("maps grant kinds to consent grantor kinds, never bereaved_person_self", () => {
    expect(consentGrantorKindFor("patient_self")).toBe("patient_self");
    expect(consentGrantorKindFor("dpoa_healthcare")).toBe("dpoa_healthcare_agent");
    expect(consentGrantorKindFor("family_caregiver")).toBe("healthcare_surrogate");
    expect(consentGrantorKindFor("personal_representative")).toBe("healthcare_surrogate");
    expect(consentGrantorKindFor("bereaved_family")).toBeNull();
  });
});

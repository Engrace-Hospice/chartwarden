import { describe, expect, it } from "vitest";
import { type PortalConsentSignInput, createPortalConsentSigner } from "../portal-consent-signer";

type View = {
  id: string;
  typeKey: string;
  createdById: string;
  status: string;
  scopeDescriptor?: unknown;
};

const mine = { kind: "categorical", documentKind: "hipaa_npp_acknowledgement", requestId: "req-1" };

const input: PortalConsentSignInput = {
  organizationId: "org-1",
  patientId: "pat-1",
  typeKey: "hipaa_npp_acknowledgement",
  grantorKind: "healthcare_surrogate",
  actingConsentId: null,
  grantorRelationshipText: "Daughter",
  portalUserId: "user-1",
  requestId: "req-1",
  portalAccountId: "acct-1",
  portalSessionId: "sess-1",
  signerName: "Pat Example",
  existingConsentId: null,
};

function fakeService(initial: View[] = []) {
  const rows = [...initial];
  const calls: string[] = [];
  const service = {
    getConsent: async (_o: string, id: string) => rows.find((r) => r.id === id) ?? null,
    listConsentsForPatient: async () => rows,
    createDraft: async (
      _o: string,
      i: {
        typeKey: string;
        createdById: string;
        captureMethod: string;
        scopeDescriptor: unknown;
      },
    ) => {
      calls.push(`draft:${i.captureMethod}`);
      const row = {
        id: `c-${rows.length + 1}`,
        typeKey: i.typeKey,
        createdById: i.createdById,
        status: "draft",
        scopeDescriptor: i.scopeDescriptor,
      };
      rows.push(row);
      return row;
    },
    signConsent: async (
      _o: string,
      id: string,
      signer: string,
      _now: string,
      evidence: unknown,
    ) => {
      calls.push(`sign:${signer}:${JSON.stringify(evidence)}`);
      const row = rows.find((r) => r.id === id) as View;
      row.status = "active";
      return row;
    },
  };
  return {
    signer: createPortalConsentSigner(service as any, () => "2026-11-04T12:00:00.000Z"),
    calls,
    rows,
  };
}

describe("createPortalConsentSigner", () => {
  it("creates a draft with the portal capture method, then signs it with the portal session as evidence", async () => {
    const { signer, calls } = fakeService();
    const r = await signer.sign(input);
    expect(r.recordId).toBe("c-1");
    expect(calls).toEqual([
      "draft:electronic_portal_signature",
      'sign:user-1:{"portalSessionId":"sess-1","typedSignatureName":"Pat Example"}',
    ]);
  });

  it("returns an already-active consent of this account without signing again", async () => {
    const { signer, calls } = fakeService([
      {
        id: "c-9",
        typeKey: "hipaa_npp_acknowledgement",
        createdById: "user-1",
        status: "active",
        scopeDescriptor: mine,
      },
    ]);
    expect(await signer.sign(input)).toEqual({ recordId: "c-9" });
    expect(calls).toEqual([]);
  });

  it("signs, rather than recreating, a draft left by a crashed attempt", async () => {
    const { signer, calls, rows } = fakeService([
      {
        id: "c-5",
        typeKey: "hipaa_npp_acknowledgement",
        createdById: "user-1",
        status: "draft",
        scopeDescriptor: mine,
      },
    ]);
    expect(await signer.sign(input)).toEqual({ recordId: "c-5" });
    expect(rows).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("does not adopt another account's consent", async () => {
    const { signer, rows } = fakeService([
      {
        id: "c-7",
        typeKey: "hipaa_npp_acknowledgement",
        createdById: "someone-else",
        status: "active",
        scopeDescriptor: mine,
      },
    ]);
    const r = await signer.sign(input);
    expect(r.recordId).toBe("c-2");
    expect(rows).toHaveLength(2);
  });

  it("does not reuse the signature of an earlier request for the same document", async () => {
    const { signer, rows, calls } = fakeService([
      {
        id: "c-3",
        typeKey: "hipaa_npp_acknowledgement",
        createdById: "user-1",
        status: "active",
        scopeDescriptor: { ...mine, requestId: "req-0" },
      },
    ]);
    const r = await signer.sign(input);
    expect(r.recordId).toBe("c-2");
    expect(rows).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });
});

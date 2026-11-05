import { describe, expect, it } from "vitest";
import { createPortalAdmissionSigners } from "../portal-document-signers";

function setup(opts: { esState?: string; nor?: boolean } = {}) {
  const calls: string[] = [];
  let norExists = opts.nor ?? false;
  const service = {
    getElectionStatement: async () => ({
      id: "es-1",
      state: opts.esState ?? "drafted",
      version: 3,
    }),
    signElection: async (_o: string, id: string, v: number, actor: string, input: object) => {
      calls.push(`sign:${id}:v${v}:actor=${actor}:${JSON.stringify(input)}`);
      return { id, state: "signed", version: v + 1 };
    },
    getNor: async () => (norExists ? { id: "nor-1", state: "acknowledged", version: 1 } : null),
    acknowledgeNor: async (_o: string, _a: string, input: object, actor: string) => {
      calls.push(`nor:actor=${actor}:${JSON.stringify(input)}`);
      norExists = true;
      return { id: "adm-1", state: "notice_of_rights_acknowledged", version: 2 };
    },
  };
  const signers = createPortalAdmissionSigners({
    // biome-ignore lint/suspicious/noExplicitAny: a structural fake of the narrow service surface
    service: service as any,
    readPatientName: async () => "Pat Patient",
    nowIso: () => "2026-11-04T12:00:00.000Z",
  });
  return { signers, calls };
}

const base = { organizationId: "org-1", signerName: "Rep Example" };

describe("portal admission signers", () => {
  it("signs a drafted election with the portal method and the PATIENT's name, not the signer's", async () => {
    const { signers, calls } = setup();
    const r = await signers.election({
      ...base,
      electionStatementId: "es-1",
      patientId: "pat-1",
      signerRole: "legal_representative",
      signatureMethod: "electronic_portal",
    });
    expect(r).toEqual({ recordId: "es-1" });
    expect(calls).toEqual([
      'sign:es-1:v3:actor=:{"signingPatientName":"Pat Patient","signingRole":"legal_representative","signatureMethod":"electronic_portal"}',
    ]);
  });

  it("links an election that is already signed instead of signing again", async () => {
    const { signers, calls } = setup({ esState: "signed" });
    const r = await signers.election({
      ...base,
      electionStatementId: "es-1",
      patientId: "pat-1",
      signerRole: "patient",
      signatureMethod: "electronic_portal",
    });
    expect(r).toEqual({ recordId: "es-1" });
    expect(calls).toEqual([]);
  });

  it("acknowledges the notice of rights with the portal method, and links an existing acknowledgment on retry", async () => {
    const first = setup();
    const r = await first.signers.noticeOfRights({
      ...base,
      admissionId: "adm-1",
      signerRole: "caregiver_on_behalf",
      deliveryMethod: "electronic_portal",
    });
    expect(r).toEqual({ recordId: "nor-1" });
    expect(first.calls[0]).toContain('"deliveryMethod":"electronic_portal"');
    expect(first.calls[0]).toContain("actor=:");

    const retry = setup({ nor: true });
    expect(
      await retry.signers.noticeOfRights({
        ...base,
        admissionId: "adm-1",
        signerRole: "patient",
        deliveryMethod: "electronic_portal",
      }),
    ).toEqual({ recordId: "nor-1" });
    expect(retry.calls).toEqual([]);
  });
});

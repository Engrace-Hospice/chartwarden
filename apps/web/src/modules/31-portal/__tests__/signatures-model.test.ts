import { describe, expect, it } from "vitest";
import { refusalMessage, sendOptions } from "../signatures-model";

describe("sendOptions", () => {
  it("always offers the privacy notice and consent; consent is labelled pending legal review", () => {
    const options = sendOptions({ draftedElectionStatementId: null, admissionId: null });
    expect(options.map((o) => o.kind)).toEqual(["hipaa_npp_acknowledgement", "consent_to_treat"]);
    expect(options[1]?.label).toContain("pending legal review");
    expect(options[1]?.hint).toContain("cannot sign");
  });

  it("offers the election only with a drafted statement and the notice of rights only with an admission, each carrying its target", () => {
    const options = sendOptions({ draftedElectionStatementId: "es-1", admissionId: "adm-1" });
    expect(options.find((o) => o.kind === "election_statement")?.targetRef).toBe("es-1");
    expect(options.find((o) => o.kind === "notice_of_patient_rights")?.targetRef).toBe("adm-1");
    expect(
      sendOptions({ draftedElectionStatementId: null, admissionId: "adm-1" }).map((o) => o.kind),
    ).not.toContain("election_statement");
  });
});

describe("refusalMessage", () => {
  const body = (code: string, message = "server words") => ({ error: { code, message } });
  it("uses our own wording for the three refusals staff can hit", () => {
    expect(refusalMessage(body("SIGNATURE_REQUEST_ALREADY_OPEN"), "x")).toContain("already open");
    expect(refusalMessage(body("SIGNATURE_TARGET_INVALID"), "x")).toContain("cannot be sent");
    expect(refusalMessage(body("M06_DOCUMENT_RECORDED_IN_ADMISSION"), "x")).toBe(
      "Record this paper signature in the admission workflow, then withdraw the request as signed on paper.",
    );
  });
  it("falls back to the server message, then the caller's fallback", () => {
    expect(refusalMessage(body("OTHER", "server words"), "fb")).toBe("server words");
    expect(refusalMessage(undefined, "fb")).toBe("fb");
  });
});

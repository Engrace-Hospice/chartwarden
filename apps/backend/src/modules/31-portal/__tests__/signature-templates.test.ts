import { describe, expect, it } from "vitest";
import { documentTextFor, signedContentFor } from "../routes/signature.routes";
import { SIGNATURE_TEMPLATES } from "../signature-templates";

describe("signature templates", () => {
  it("carries the NPP wording and cites 45 CFR 164.520", () => {
    expect(documentTextFor("hipaa_npp_acknowledgement")?.paragraphs.join(" ")).toMatch(/164\.520/);
  });

  it("keeps Consent to Treat a marked placeholder that production refuses to sign", () => {
    expect(SIGNATURE_TEMPLATES.consent_to_treat.version).toContain("pending-legal-review");
    expect(documentTextFor("consent_to_treat")?.title).toMatch(/pending legal review/);
  });

  it("has no wording for the M06 documents, which carry theirs in the admission record", () => {
    expect(documentTextFor("election_statement")).toBeNull();
    expect(documentTextFor("notice_of_patient_rights")).toBeNull();
  });

  it("changes the signed content when the wording differs", () => {
    expect(signedContentFor("hipaa_npp_acknowledgement", "1.0.0")).not.toBe(
      signedContentFor("consent_to_treat", "1.0.0"),
    );
  });
});

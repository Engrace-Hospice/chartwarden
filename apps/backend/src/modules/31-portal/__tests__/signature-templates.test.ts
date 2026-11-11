import { describe, expect, it } from "vitest";
import { documentTextFor, signedContentFor } from "../routes/signature.routes";
import {
  AGENCY_NAME_FALLBACK,
  SIGNATURE_TEMPLATES,
  portalSigningBlocker,
} from "../signature-templates";

describe("portalSigningBlocker", () => {
  it("gives every document wording to show, so nothing is signed unseen", () => {
    for (const kind of Object.keys(SIGNATURE_TEMPLATES) as Array<
      keyof typeof SIGNATURE_TEMPLATES
    >) {
      expect(documentTextFor(kind)?.paragraphs.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("blocks a draft kind's older request too, since the portal shows the current wording", () => {
    expect(portalSigningBlocker("election_statement", "1.0.0", false)).toBe(
      "template_pending_legal_review",
    );
    expect(portalSigningBlocker("election_statement", "1.0.0", true)).toBeNull();
  });

  it("blocks unapproved wording unless the tenant allows it, and passes the NPP", () => {
    const draft = SIGNATURE_TEMPLATES.consent_to_treat.version;
    expect(portalSigningBlocker("consent_to_treat", draft, false)).toBe(
      "template_pending_legal_review",
    );
    expect(portalSigningBlocker("consent_to_treat", draft, true)).toBeNull();
    const npp = SIGNATURE_TEMPLATES.hipaa_npp_acknowledgement.version;
    expect(portalSigningBlocker("hipaa_npp_acknowledgement", npp, false)).toBeNull();
  });
});

describe("signature templates", () => {
  it("carries the NPP wording and cites 45 CFR 164.520", () => {
    expect(documentTextFor("hipaa_npp_acknowledgement")?.paragraphs.join(" ")).toMatch(/164\.520/);
  });

  it("keeps Consent to Treat a marked placeholder that production refuses to sign", () => {
    expect(SIGNATURE_TEMPLATES.consent_to_treat.version).toContain("pending-legal-review");
    expect(documentTextFor("consent_to_treat")?.title).toMatch(/pending legal review/);
  });

  it("marks the M06 placeholders as drafts nobody may mistake for the real document", () => {
    for (const kind of ["election_statement", "notice_of_patient_rights"] as const) {
      expect(SIGNATURE_TEMPLATES[kind].version).toContain("pending-legal-review");
      expect(documentTextFor(kind)?.title).toMatch(/pending legal review/);
    }
  });

  it("changes the signed content when the wording differs", () => {
    expect(signedContentFor("hipaa_npp_acknowledgement", "1.0.0")).not.toBe(
      signedContentFor("consent_to_treat", "1.0.0"),
    );
  });

  it("names the tenant's agency in the NPP, or falls back without a stray marker", () => {
    const named = documentTextFor("hipaa_npp_acknowledgement", "Cedar Valley Hospice");
    expect(named?.paragraphs.join(" ")).toContain("Cedar Valley Hospice's Notice");
    const unnamed = documentTextFor("hipaa_npp_acknowledgement", null);
    expect(unnamed?.paragraphs.join(" ")).toContain(AGENCY_NAME_FALLBACK);
    expect(unnamed?.paragraphs.join(" ")).not.toContain("{agency}");
  });

  it("binds the agency name into the signed content", () => {
    expect(signedContentFor("hipaa_npp_acknowledgement", "1.0.0", "A")).not.toBe(
      signedContentFor("hipaa_npp_acknowledgement", "1.0.0", "B"),
    );
  });
});

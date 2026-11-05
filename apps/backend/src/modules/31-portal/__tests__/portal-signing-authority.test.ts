import { describe, expect, it } from "vitest";
import {
  PORTAL_SIGNING_AUTHORITY,
  type PortalSigningGrantKind,
  decideSigningAuthority,
} from "../portal-signing-authority";

const GRANT_KINDS: readonly PortalSigningGrantKind[] = [
  "patient_self",
  "dpoa_healthcare",
  "family_caregiver",
  "personal_representative",
  "bereaved_family",
];
const DOC_KINDS = [
  "election_statement",
  "notice_of_patient_rights",
  "hipaa_npp_acknowledgement",
  "consent_to_treat",
] as const;

describe("portal signing authority matrix (fail closed)", () => {
  it("lets the patient sign every document as the patient, with no explanation needed", () => {
    for (const doc of DOC_KINDS) {
      expect(decideSigningAuthority({ grantKind: "patient_self", docKind: doc })).toEqual({
        allowed: true,
        signerRole: "patient",
        requiresRelationship: false,
        requiresPatientUnableReason: false,
      });
    }
  });

  it("lets a healthcare agent sign every document as a legal representative, saying who they are", () => {
    for (const doc of DOC_KINDS) {
      expect(decideSigningAuthority({ grantKind: "dpoa_healthcare", docKind: doc })).toEqual({
        allowed: true,
        signerRole: "legal_representative",
        requiresRelationship: true,
        requiresPatientUnableReason: false,
      });
    }
  });

  it("lets a family caregiver sign rights, NPP and consent to treat only when they say why the patient could not", () => {
    for (const doc of [
      "notice_of_patient_rights",
      "hipaa_npp_acknowledgement",
      "consent_to_treat",
    ] as const) {
      expect(decideSigningAuthority({ grantKind: "family_caregiver", docKind: doc })).toEqual({
        allowed: true,
        signerRole: "caregiver_on_behalf",
        requiresRelationship: true,
        requiresPatientUnableReason: true,
      });
    }
  });

  it("never lets a family caregiver elect hospice for the patient", () => {
    expect(
      decideSigningAuthority({ grantKind: "family_caregiver", docKind: "election_statement" }),
    ).toEqual({ allowed: false, reason: "not_authorized_for_document" });
  });

  it("lets a post-death personal representative acknowledge the NPP and nothing else", () => {
    expect(
      decideSigningAuthority({
        grantKind: "personal_representative",
        docKind: "hipaa_npp_acknowledgement",
      }),
    ).toMatchObject({
      allowed: true,
      signerRole: "legal_representative",
      requiresRelationship: true,
    });
    for (const doc of [
      "election_statement",
      "notice_of_patient_rights",
      "consent_to_treat",
    ] as const) {
      expect(
        decideSigningAuthority({ grantKind: "personal_representative", docKind: doc }).allowed,
      ).toBe(false);
    }
  });

  it("denies a bereaved-family grant every document", () => {
    for (const doc of DOC_KINDS) {
      expect(decideSigningAuthority({ grantKind: "bereaved_family", docKind: doc }).allowed).toBe(
        false,
      );
    }
  });

  it("denies an unknown grant kind or document kind instead of guessing", () => {
    expect(decideSigningAuthority({ grantKind: "mystery", docKind: "consent_to_treat" })).toEqual({
      allowed: false,
      reason: "unknown_grant_or_document",
    });
    expect(decideSigningAuthority({ grantKind: "patient_self", docKind: "mystery" })).toEqual({
      allowed: false,
      reason: "unknown_grant_or_document",
    });
    expect(decideSigningAuthority({ grantKind: null, docKind: "consent_to_treat" }).allowed).toBe(
      false,
    );
  });

  it("covers every (grant kind, document kind) pair explicitly, so a new kind cannot be allowed by omission", () => {
    for (const grant of GRANT_KINDS) {
      for (const doc of DOC_KINDS) {
        expect(PORTAL_SIGNING_AUTHORITY[grant]).toHaveProperty(doc);
      }
    }
  });
});

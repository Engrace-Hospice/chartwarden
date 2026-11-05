// M31 ADR-0107 (PROPOSED) — who may sign which admission document through the portal. A PURE decision over a portal grant kind and a
// document kind (no resolver, no seams, no clock), so every cell is unit-tested. It is the portal's first gate only: the M06 / M39
// state machines still decide the document itself (for an election, R-EL-01 still needs an active healthcare-DPOA consent on file).
//
// FAIL CLOSED: every (grant kind, document kind) pair is written out below, and anything not written out — an unknown grant kind, an
// unknown document kind, a null — is denied. A new grant kind or document kind therefore cannot be allowed by omission (the exhaustiveness
// test fails until its row is written).
//
// Decisions behind the cells (the product owner's answers, 2026-11-04):
//   * the patient signs everything as the patient;
//   * a healthcare agent (dpoa_healthcare) signs everything as a legal representative and says who they are;
//   * a family caregiver may sign the notice of rights, the NPP acknowledgement and consent to treat WHEN THE PATIENT CANNOT — so they
//     must say who they are AND why the patient did not sign (mirrors the paper form's "reason patient did not sign"); a caregiver
//     never makes the hospice election for the patient;
//   * a post-death personal representative may acknowledge the NPP only (an election and a consent to treat are moot after death);
//   * a bereaved-family grant is record access, never signing.
import type { schema } from "@chartwarden/db";

type PortalSignatureDocKind = schema.PortalSignatureDocKind;
type PortalSignerRole = schema.PortalSignerRole;

export type PortalSigningGrantKind =
  | "patient_self"
  | "dpoa_healthcare"
  | "family_caregiver"
  | "personal_representative"
  | "bereaved_family";

/** What the signer must supply, and the role their signature is recorded under. */
export interface SigningPermit {
  readonly signerRole: PortalSignerRole;
  /** The signer states who they are to the patient (relationship or legal authority). */
  readonly requiresRelationship: boolean;
  /** The signer states why the patient did not sign. */
  readonly requiresPatientUnableReason: boolean;
}

export type SigningDecision =
  | ({ readonly allowed: true } & SigningPermit)
  | {
      readonly allowed: false;
      readonly reason: "not_authorized_for_document" | "unknown_grant_or_document";
    };

const PATIENT: SigningPermit = {
  signerRole: "patient",
  requiresRelationship: false,
  requiresPatientUnableReason: false,
};
const AGENT: SigningPermit = {
  signerRole: "legal_representative",
  requiresRelationship: true,
  requiresPatientUnableReason: false,
};
const CAREGIVER: SigningPermit = {
  signerRole: "caregiver_on_behalf",
  requiresRelationship: true,
  requiresPatientUnableReason: true,
};
const DENY = null;

type Row = Readonly<Record<PortalSignatureDocKind, SigningPermit | null>>;

/** Every pair is explicit; `null` means denied. Exported so the exhaustiveness test can prove no pair is missing. */
export const PORTAL_SIGNING_AUTHORITY: Readonly<Record<PortalSigningGrantKind, Row>> = {
  patient_self: {
    election_statement: PATIENT,
    notice_of_patient_rights: PATIENT,
    hipaa_npp_acknowledgement: PATIENT,
    consent_to_treat: PATIENT,
  },
  dpoa_healthcare: {
    election_statement: AGENT,
    notice_of_patient_rights: AGENT,
    hipaa_npp_acknowledgement: AGENT,
    consent_to_treat: AGENT,
  },
  family_caregiver: {
    election_statement: DENY,
    notice_of_patient_rights: CAREGIVER,
    hipaa_npp_acknowledgement: CAREGIVER,
    consent_to_treat: CAREGIVER,
  },
  personal_representative: {
    election_statement: DENY,
    notice_of_patient_rights: DENY,
    hipaa_npp_acknowledgement: AGENT,
    consent_to_treat: DENY,
  },
  bereaved_family: {
    election_statement: DENY,
    notice_of_patient_rights: DENY,
    hipaa_npp_acknowledgement: DENY,
    consent_to_treat: DENY,
  },
};

const has = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

/** Decide whether a portal grant may sign a document, and under what role and with what explanation. */
export function decideSigningAuthority(input: {
  readonly grantKind: string | null | undefined;
  readonly docKind: string | null | undefined;
}): SigningDecision {
  const { grantKind, docKind } = input;
  if (!grantKind || !docKind || !has(PORTAL_SIGNING_AUTHORITY, grantKind)) {
    return { allowed: false, reason: "unknown_grant_or_document" };
  }
  const row = PORTAL_SIGNING_AUTHORITY[grantKind as PortalSigningGrantKind];
  if (!has(row, docKind)) return { allowed: false, reason: "unknown_grant_or_document" };
  const permit = row[docKind as PortalSignatureDocKind];
  return permit === null
    ? { allowed: false, reason: "not_authorized_for_document" }
    : { allowed: true, ...permit };
}

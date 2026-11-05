// M31 ADR-0107 (PROPOSED) — which template a staff-sent request carries, per document kind. Staff never choose a template key or version: the
// server stamps them, so a request cannot be created against a version nobody reviewed. The Consent to Treat wording is still "pending legal
// review" — its version carries that marker, which `signAdmissionDocument` refuses to sign unless the tenant opts in.
// The NPP wording comes from the agency's paper form; the Consent to Treat is a placeholder until legal review (its version keeps it unsignable on production).
import type { schema } from "@chartwarden/db";

/** The words the portal shows before the person signs. Absent for the two M06 documents, whose wording lives in the M06 admission record. */
export interface SignatureDocumentText {
  readonly title: string;
  readonly paragraphs: readonly string[];
}

export interface SignatureTemplate {
  readonly key: string;
  readonly version: string;
  readonly text?: SignatureDocumentText;
}

/** HIPAA NPP acknowledgement (45 CFR 164.520). Wording follows the agency's paper form; the agency name is the patient's own hospice, not hard-coded. */
const NPP_TEXT: SignatureDocumentText = {
  title: "Acknowledgment of Receipt of Notice of Privacy Practices",
  paragraphs: [
    "Federal law (HIPAA, 45 CFR 164.520) requires your hospice to give you its Notice of Privacy Practices and to make a good-faith effort to get your written acknowledgment that you received it. Signing this form does not mean you agree with the Notice; it only confirms you received a copy.",
    "I acknowledge that I received a copy of my hospice's Notice of Privacy Practices. The Notice explains how my health information may be used and disclosed, my rights regarding that information, and how to file a complaint. I understand I may request another copy at any time and that the Notice is posted on my hospice's website.",
    "If you are signing for the patient, you will be asked for your relationship or legal authority and, if the patient could not sign, the reason.",
  ],
};

/** PLACEHOLDER. Not legal wording: it is written so nobody mistakes it for the real consent, and the version below keeps it unsignable on production. */
const CONSENT_TO_TREAT_PLACEHOLDER: SignatureDocumentText = {
  title: "Consent to Treat (draft, pending legal review)",
  paragraphs: [
    "DRAFT. This is placeholder text and is not the agency's approved consent to treat. It must not be used for a real patient.",
    "The approved wording will replace this text, and a new template version will be recorded, after the agency's legal review.",
  ],
};

export const SIGNATURE_TEMPLATES: Readonly<
  Record<schema.PortalSignatureDocKind, SignatureTemplate>
> = {
  election_statement: { key: "election_statement_v1", version: "1.0.0" },
  notice_of_patient_rights: { key: "notice_of_patient_rights_v1", version: "1.0.0" },
  hipaa_npp_acknowledgement: {
    key: "hipaa_npp_acknowledgement_v1",
    version: "1.0.0",
    text: NPP_TEXT,
  },
  consent_to_treat: {
    key: "consent_to_treat_v1",
    version: "0.0.0-pending-legal-review",
    text: CONSENT_TO_TREAT_PLACEHOLDER,
  },
};

/** The two kinds that sign INTO M06 and so must name the M06 record they sign (the staff-drafted statement, or the admission). */
export const M06_DOC_KINDS: ReadonlySet<schema.PortalSignatureDocKind> = new Set([
  "election_statement",
  "notice_of_patient_rights",
]);

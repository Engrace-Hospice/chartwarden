// M31 ADR-0107 (PROPOSED) — which template a staff-sent request carries, per document kind. Staff never choose a template key or version: the
// server stamps them, so a request cannot be created against a version nobody reviewed. The Consent to Treat wording is still "pending legal
// review" — its version carries that marker, which `signAdmissionDocument` refuses to sign unless the tenant opts in.
// The NPP wording comes from the agency's paper form; the Consent to Treat is a placeholder until legal review (its version keeps it unsignable on production).
import type { schema } from "@chartwarden/db";

/** The words the portal shows before the person signs. Every template has them: signing attests "I have read this document". */
export interface SignatureDocumentText {
  readonly title: string;
  readonly paragraphs: readonly string[];
}

export interface SignatureTemplate {
  readonly key: string;
  readonly version: string;
  readonly text: SignatureDocumentText;
}

/** HIPAA NPP acknowledgement (45 CFR 164.520). Wording follows the agency's paper form; `{agency}` is replaced with the tenant's agency name when shown. */
const NPP_TEXT: SignatureDocumentText = {
  title: "Acknowledgment of Receipt of Notice of Privacy Practices",
  paragraphs: [
    "Federal law (HIPAA, 45 CFR 164.520) requires {agency} to give you its Notice of Privacy Practices and to make a good-faith effort to get your written acknowledgment that you received it. Signing this form does not mean you agree with the Notice; it only confirms you received a copy.",
    "I acknowledge that I received a copy of {agency}'s Notice of Privacy Practices. The Notice explains how my health information may be used and disclosed, my rights regarding that information, and how to file a complaint. I understand I may request another copy at any time and that the Notice is posted on {agency}'s website.",
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

/** PLACEHOLDER. M06 stores who signed and when, not the wording; the approved Election Statement (42 CFR 418.24(b)) replaces this after legal review. */
const ELECTION_STATEMENT_PLACEHOLDER: SignatureDocumentText = {
  title: "Hospice Election Statement (draft, pending legal review)",
  paragraphs: [
    "DRAFT. This is placeholder text and is not the agency's approved election statement. It must not be used for a real patient.",
    "The approved wording will replace this text, and a new template version will be recorded, after the agency's legal review.",
  ],
};

/** PLACEHOLDER. The approved Notice of Patient Rights (42 CFR 418.52) replaces this after legal review. */
const NOTICE_OF_RIGHTS_PLACEHOLDER: SignatureDocumentText = {
  title: "Notice of Patient Rights (draft, pending legal review)",
  paragraphs: [
    "DRAFT. This is placeholder text and is not the agency's approved notice of patient rights. It must not be used for a real patient.",
    "The approved wording will replace this text, and a new template version will be recorded, after the agency's legal review.",
  ],
};

export const SIGNATURE_TEMPLATES: Readonly<
  Record<schema.PortalSignatureDocKind, SignatureTemplate>
> = {
  election_statement: {
    key: "election_statement_v1",
    version: "0.0.0-pending-legal-review",
    text: ELECTION_STATEMENT_PLACEHOLDER,
  },
  notice_of_patient_rights: {
    key: "notice_of_patient_rights_v1",
    version: "0.0.0-pending-legal-review",
    text: NOTICE_OF_RIGHTS_PLACEHOLDER,
  },
  hipaa_npp_acknowledgement: {
    key: "hipaa_npp_acknowledgement_v1",
    // 1.1.0: 1.0.0 shipped with no wording; requests signed under it keep their old evidence hash and are not re-rendered.
    version: "1.1.0",
    text: NPP_TEXT,
  },
  consent_to_treat: {
    key: "consent_to_treat_v1",
    version: "0.0.0-pending-legal-review",
    text: CONSENT_TO_TREAT_PLACEHOLDER,
  },
};

/** A template version carrying this mark has no approved wording yet (ADR-0107 D9). */
export const PENDING_REVIEW_MARK = "pending-legal-review";

const isDraft = (version: string): boolean => version.includes(PENDING_REVIEW_MARK);

/** The kinds whose CURRENT wording legal has not approved. The portal shows the current wording, so an older request of such a kind is a draft too. */
export const DRAFT_DOC_KINDS: readonly schema.PortalSignatureDocKind[] = (
  Object.entries(SIGNATURE_TEMPLATES) as Array<[schema.PortalSignatureDocKind, SignatureTemplate]>
)
  .filter(([, template]) => isDraft(template.version))
  .map(([kind]) => kind);

export type PortalSigningBlocker = "template_pending_legal_review";

/**
 * Why this request cannot be put in front of a signer, or null when it can. One rule for create, sign, accept and the reminder sweep, so
 * nothing sends, reminds or signs wording legal has not approved, unless the tenant opts in (never on production).
 */
export function portalSigningBlocker(
  docKind: schema.PortalSignatureDocKind,
  templateVersion: string,
  allowUnreviewedTemplates: boolean,
): PortalSigningBlocker | null {
  if (allowUnreviewedTemplates) return null;
  return isDraft(templateVersion) || DRAFT_DOC_KINDS.includes(docKind)
    ? "template_pending_legal_review"
    : null;
}

/** The two kinds that sign INTO M06 and so must name the M06 record they sign (the staff-drafted statement, or the admission). */
export const M06_DOC_KINDS: ReadonlySet<schema.PortalSignatureDocKind> = new Set([
  "election_statement",
  "notice_of_patient_rights",
]);

/** The word used when a tenant's agency name cannot be read: the wording still makes sense, it just does not name the agency. */
export const AGENCY_NAME_FALLBACK = "your hospice";

/** Fills the `{agency}` marker with the tenant's agency name (or the fallback). Pure. */
export function renderDocumentText(
  text: SignatureDocumentText,
  agencyName: string | null,
): SignatureDocumentText {
  const name = agencyName?.trim() || AGENCY_NAME_FALLBACK;
  return {
    title: text.title.replaceAll("{agency}", name),
    paragraphs: text.paragraphs.map((p) => p.replaceAll("{agency}", name)),
  };
}

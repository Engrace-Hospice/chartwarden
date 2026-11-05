// M31 ADR-0107 (PROPOSED) — which template a staff-sent request carries, per document kind. Staff never choose a template key or version: the
// server stamps them, so a request cannot be created against a version nobody reviewed. The Consent to Treat wording is still "pending legal
// review" — its version carries that marker, which `signAdmissionDocument` refuses to sign unless the tenant opts in.
// The document body text (NPP wording, Consent to Treat) is added to this registry by the template slice; the keys and versions stay.
import type { schema } from "@chartwarden/db";

export interface SignatureTemplate {
  readonly key: string;
  readonly version: string;
}

export const SIGNATURE_TEMPLATES: Readonly<
  Record<schema.PortalSignatureDocKind, SignatureTemplate>
> = {
  election_statement: { key: "election_statement_v1", version: "1.0.0" },
  notice_of_patient_rights: { key: "notice_of_patient_rights_v1", version: "1.0.0" },
  hipaa_npp_acknowledgement: { key: "hipaa_npp_acknowledgement_v1", version: "1.0.0" },
  consent_to_treat: { key: "consent_to_treat_v1", version: "0.0.0-pending-legal-review" },
};

/** The two kinds that sign INTO M06 and so must name the M06 record they sign (the staff-drafted statement, or the admission). */
export const M06_DOC_KINDS: ReadonlySet<schema.PortalSignatureDocKind> = new Set([
  "election_statement",
  "notice_of_patient_rights",
]);

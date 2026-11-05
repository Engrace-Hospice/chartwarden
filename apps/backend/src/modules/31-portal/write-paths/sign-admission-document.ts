// M31 ADR-0107 (PROPOSED) — the portal sign step for one admission document. Order is fixed by ADR D2:
//   1. authority (matrix + the grant's source consent), 2. the authoritative M06 / M39 signer, 3. record the result on the request.
// M06 / M39 each own their transaction, so steps 2 and 3 cannot be atomic. The step is therefore retry-safe instead: every signer port is
// idempotent (it returns the already-signed record rather than signing twice), and a request already `signed` returns as-is. A crash
// between 2 and 3 leaves the request `pending`; the retry re-enters, the port reports the existing record, and step 3 links it.
//
// Pure orchestration over ports: no db, no seams, no clock. The composition root binds the ports (route PR); the tests bind fakes.
import type { schema } from "@chartwarden/db";
import { type PortalSigningGrantKind, decideSigningAuthority } from "../portal-signing-authority";

type DocKind = schema.PortalSignatureDocKind;
type SignerRole = schema.PortalSignerRole;

/** The consent grantor kinds this path can produce (a subset of M39's `ConsentGrantorKind`). */
export type PortalConsentGrantorKind =
  | "patient_self"
  | "dpoa_healthcare_agent"
  | "healthcare_surrogate";

/**
 * Grantor-kind mapping for the two M39-backed documents (ADR-0107 D3):
 *   patient → patient_self; healthcare agent → dpoa_healthcare_agent (cites its DPOA consent);
 *   caregiver and post-death representative → healthcare_surrogate. M39 reserves `bereaved_person_self` for
 *   the bereavement-outreach consent, so a post-death NPP acknowledgement is NOT filed under it.
 */
export function consentGrantorKindFor(
  grantKind: PortalSigningGrantKind,
): PortalConsentGrantorKind | null {
  switch (grantKind) {
    case "patient_self":
      return "patient_self";
    case "dpoa_healthcare":
      return "dpoa_healthcare_agent";
    case "family_caregiver":
    case "personal_representative":
      return "healthcare_surrogate";
    default:
      return null;
  }
}

export interface PortalSignerContext {
  /** The portal login's `user` row. M39's audit trigger records the actor as a `user`, so this (not the account id) is the actor id. */
  readonly portalUserId: string;
  readonly portalAccountId: string;
  readonly portalSessionId: string;
  readonly grantKind: PortalSigningGrantKind;
  /** The M39 consent the grant was issued from (`portal_access_grant.source_consent_record_id`). */
  readonly sourceConsentRecordId: string;
}

export interface SignatureRequestRecord {
  readonly id: string;
  readonly patientId: string;
  readonly docKind: DocKind;
  readonly status: "pending" | "signed" | "uploaded_pending_review" | "voided";
  /** Election statement id / admission id (M06) set when staff create the request; consent id (M39) once signed. */
  readonly targetRef: string | null;
  readonly templateVersion: string;
}

export interface SignerStatement {
  readonly signedTypedName: string;
  readonly signerRelationshipText?: string;
  readonly patientUnableReason?: string;
  readonly attestationSha256: string;
  readonly idempotencyKey: string;
}

export interface SignatureRequestStore {
  get(organizationId: string, requestId: string): Promise<SignatureRequestRecord | null>;
  /** pending | uploaded_pending_review → signed, in one UPDATE; the DB guard rejects any other move. */
  markSigned(
    organizationId: string,
    requestId: string,
    input: {
      readonly targetRef: string;
      readonly signer: PortalSignerContext;
      readonly signerRole: SignerRole;
      readonly statement: SignerStatement;
    },
  ): Promise<SignatureRequestRecord>;
}

export interface SignedRecord {
  readonly recordId: string;
}

/** Idempotent: when the document is already signed, return its record id and sign nothing. */
export interface AdmissionDocumentSigners {
  election(input: {
    organizationId: string;
    electionStatementId: string;
    /** M06 records the PATIENT's name at signing (not the signer's), so the adapter resolves it from the patient. */
    patientId: string;
    signerRole: SignerRole;
    signerName: string;
    signatureMethod: "electronic_portal";
  }): Promise<SignedRecord>;
  noticeOfRights(input: {
    organizationId: string;
    admissionId: string;
    signerRole: SignerRole;
    signerName: string;
    deliveryMethod: "electronic_portal";
  }): Promise<SignedRecord>;
  consent(input: {
    organizationId: string;
    patientId: string;
    typeKey: "hipaa_npp_acknowledgement" | "consent_to_treat";
    grantorKind: PortalConsentGrantorKind;
    actingConsentId: string | null;
    grantorRelationshipText: string | null;
    portalUserId: string;
    requestId: string;
    portalAccountId: string;
    portalSessionId: string;
    signerName: string;
    /** A consent already created for this request on an earlier attempt. */
    existingConsentId: string | null;
  }): Promise<SignedRecord>;
}

/** M39 read of one consent's status — the grant's source consent must still be a live healthcare DPOA for this patient. */
export interface ConsentStatusReader {
  read(
    organizationId: string,
    consentId: string,
  ): Promise<{
    readonly patientId: string;
    readonly typeKey: string;
    readonly status: string;
  } | null>;
}

export type SignDenyCode =
  | "request_not_found"
  | "request_not_open"
  | "not_authorized_for_document"
  | "relationship_required"
  | "patient_unable_reason_required"
  | "signer_name_required"
  | "dpoa_consent_not_active"
  | "template_pending_legal_review"
  | "request_target_missing"
  | "grant_kind_unsupported";

export type SignOutcome =
  | { readonly ok: true; readonly request: SignatureRequestRecord; readonly alreadySigned: boolean }
  | { readonly ok: false; readonly code: SignDenyCode };

export interface SignAdmissionDocumentDeps {
  readonly requests: SignatureRequestStore;
  readonly signers: AdmissionDocumentSigners;
  readonly consents: ConsentStatusReader;
  /** false on production tenants: a `0.0.0-pending-legal-review` template cannot be signed. */
  readonly allowUnreviewedTemplates: boolean;
}

const MIN_NAME = 2;
const PENDING_REVIEW_MARK = "pending-legal-review";
const deny = (code: SignDenyCode): SignOutcome => ({ ok: false, code });
const blank = (v: string | undefined): boolean => (v ?? "").trim().length === 0;

export async function signAdmissionDocument(
  deps: SignAdmissionDocumentDeps,
  input: {
    readonly organizationId: string;
    readonly requestId: string;
    readonly signer: PortalSignerContext;
    readonly statement: SignerStatement;
  },
): Promise<SignOutcome> {
  const { organizationId, requestId, signer, statement } = input;
  const request = await deps.requests.get(organizationId, requestId);
  if (!request) return deny("request_not_found");
  if (request.status === "signed") return { ok: true, request, alreadySigned: true };
  if (request.status === "voided") return deny("request_not_open");

  const decision = decideSigningAuthority({
    grantKind: signer.grantKind,
    docKind: request.docKind,
  });
  if (!decision.allowed) return deny("not_authorized_for_document");
  if (statement.signedTypedName.trim().length < MIN_NAME) return deny("signer_name_required");
  if (decision.requiresRelationship && blank(statement.signerRelationshipText))
    return deny("relationship_required");
  if (decision.requiresPatientUnableReason && blank(statement.patientUnableReason))
    return deny("patient_unable_reason_required");
  if (!deps.allowUnreviewedTemplates && request.templateVersion.includes(PENDING_REVIEW_MARK))
    return deny("template_pending_legal_review");

  // R-EL-01 widened for the portal: a healthcare agent must hold a grant issued from a LIVE healthcare-DPOA consent of THIS patient.
  // M06's own check only asks that some DPOA consent exists for the patient; here the signer's own grant must trace to it.
  let actingConsentId: string | null = null;
  if (signer.grantKind === "dpoa_healthcare") {
    const source = await deps.consents.read(organizationId, signer.sourceConsentRecordId);
    const live =
      source !== null &&
      source.patientId === request.patientId &&
      source.typeKey === "dpoa_healthcare" &&
      source.status === "active";
    if (!live) return deny("dpoa_consent_not_active");
    actingConsentId = signer.sourceConsentRecordId;
  }

  const isM06Doc =
    request.docKind === "election_statement" || request.docKind === "notice_of_patient_rights";
  if (isM06Doc && request.targetRef === null) return deny("request_target_missing");
  if (consentGrantorKindFor(signer.grantKind) === null) return deny("grant_kind_unsupported");

  const signed = await signViaAuthoritativeModule(deps, {
    organizationId,
    request,
    signer,
    statement,
    signerRole: decision.signerRole,
    actingConsentId,
  });

  const updated = await deps.requests.markSigned(organizationId, requestId, {
    targetRef: signed.recordId,
    signer,
    signerRole: decision.signerRole,
    statement,
  });
  return { ok: true, request: updated, alreadySigned: false };
}

async function signViaAuthoritativeModule(
  deps: SignAdmissionDocumentDeps,
  a: {
    organizationId: string;
    request: SignatureRequestRecord;
    signer: PortalSignerContext;
    statement: SignerStatement;
    signerRole: SignerRole;
    actingConsentId: string | null;
  },
): Promise<SignedRecord> {
  const { organizationId, request, signer, statement, signerRole } = a;
  const signerName = statement.signedTypedName.trim();
  switch (request.docKind) {
    case "election_statement":
      return deps.signers.election({
        organizationId,
        electionStatementId: request.targetRef as string,
        patientId: request.patientId,
        signerRole,
        signerName,
        signatureMethod: "electronic_portal",
      });
    case "notice_of_patient_rights":
      return deps.signers.noticeOfRights({
        organizationId,
        admissionId: request.targetRef as string,
        signerRole,
        signerName,
        deliveryMethod: "electronic_portal",
      });
    case "hipaa_npp_acknowledgement":
    case "consent_to_treat":
      return deps.signers.consent({
        organizationId,
        patientId: request.patientId,
        typeKey: request.docKind,
        grantorKind: consentGrantorKindFor(signer.grantKind) as PortalConsentGrantorKind,
        actingConsentId: a.actingConsentId,
        grantorRelationshipText: statement.signerRelationshipText?.trim() || null,
        portalUserId: signer.portalUserId,
        requestId: request.id,
        portalAccountId: signer.portalAccountId,
        portalSessionId: signer.portalSessionId,
        signerName,
        existingConsentId: request.targetRef,
      });
  }
}

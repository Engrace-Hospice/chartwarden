// M31 ADR-0107 D6 — staff ACCEPT an uploaded signed paper copy. Same call-then-record order as the portal sign step (D2):
//   1. who signed it (the UPLOADER's live grant, run through the same authority matrix), 2. the authoritative M39 record (capture method
//   uploaded signed PDF, the M22 document as evidence, the reviewing staff member as creator and signer), 3. mark the request signed.
// Retry-safe like the sign step: the consent port finds the consent THIS request already created and reuses it.
//
// Election Statement and Notice of Rights copies are NOT accepted here: M06 records a wet-ink signature through its own admission workflow
// (witness, signer kind), which this path must not shortcut. Staff record it there, then void the request as `signed_on_paper`.
// Pure orchestration over ports: no db, no seams.
import type { schema } from "@chartwarden/db";
import { type PortalSigningGrantKind, decideSigningAuthority } from "../portal-signing-authority";
import { portalSigningBlocker } from "../signature-templates";
import { type PortalConsentGrantorKind, consentGrantorKindFor } from "./sign-admission-document";

export type AcceptDenyCode =
  | "request_not_found"
  | "request_not_pending_review"
  | "m06_document_recorded_in_admission"
  | "template_pending_legal_review"
  | "uploaded_copy_missing"
  | "uploader_grant_missing"
  | "uploader_not_authorized"
  | "dpoa_consent_not_active";

export interface AcceptReviewTarget {
  readonly id: string;
  readonly patientId: string;
  readonly docKind: schema.PortalSignatureDocKind;
  readonly templateVersion: string;
  readonly status: schema.PortalSignatureStatus;
  readonly documentId: string | null;
  readonly uploaderGrant: {
    readonly grantKind: string;
    readonly sourceConsentRecordId: string;
  } | null;
}

export interface AcceptUploadedCopyDeps {
  /** false on production tenants: a copy of a "pending legal review" document cannot become an active consent. */
  readonly allowUnreviewedTemplates: boolean;
  readonly loadForReview: (
    organizationId: string,
    requestId: string,
  ) => Promise<AcceptReviewTarget | null>;
  readonly consent: (input: {
    organizationId: string;
    patientId: string;
    typeKey: "hipaa_npp_acknowledgement" | "consent_to_treat";
    grantorKind: PortalConsentGrantorKind;
    actingConsentId: string | null;
    grantorRelationshipText: string | null;
    requestId: string;
    reviewerUserId: string;
    uploadedPdfDocumentId: string;
  }) => Promise<{ recordId: string }>;
  readonly readConsent: (
    organizationId: string,
    consentId: string,
  ) => Promise<{ patientId: string; typeKey: string; status: string } | null>;
  readonly markAccepted: (
    organizationId: string,
    requestId: string,
    input: {
      reviewerId: string;
      targetRef: string;
      signerGrantKind: string;
      signerRole: schema.PortalSignerRole;
    },
  ) => Promise<{ readonly ok: boolean }>;
}

export type AcceptOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: AcceptDenyCode };

const deny = (code: AcceptDenyCode): AcceptOutcome => ({ ok: false, code });

export async function acceptUploadedCopy(
  deps: AcceptUploadedCopyDeps,
  input: { organizationId: string; requestId: string; reviewerUserId: string },
): Promise<AcceptOutcome> {
  const { organizationId, requestId, reviewerUserId } = input;
  const target = await deps.loadForReview(organizationId, requestId);
  if (!target) return deny("request_not_found");
  if (target.status !== "uploaded_pending_review") return deny("request_not_pending_review");
  if (target.docKind === "election_statement" || target.docKind === "notice_of_patient_rights")
    return deny("m06_document_recorded_in_admission");
  // A paper copy of a document legal has not approved must not become an active consent either (the same rule as e-signing).
  if (
    portalSigningBlocker(target.docKind, target.templateVersion, deps.allowUnreviewedTemplates) ===
    "template_pending_legal_review"
  )
    return deny("template_pending_legal_review");
  if (!target.documentId) return deny("uploaded_copy_missing");
  if (!target.uploaderGrant) return deny("uploader_grant_missing");

  const grantKind = target.uploaderGrant.grantKind as PortalSigningGrantKind;
  const decision = decideSigningAuthority({ grantKind, docKind: target.docKind });
  const grantorKind = consentGrantorKindFor(grantKind);
  if (!decision.allowed || grantorKind === null) return deny("uploader_not_authorized");

  // A healthcare agent's copy is accepted only while the grant's source DPOA is still live for THIS patient (same rule as the portal sign step).
  let actingConsentId: string | null = null;
  if (grantKind === "dpoa_healthcare") {
    const source = await deps.readConsent(
      organizationId,
      target.uploaderGrant.sourceConsentRecordId,
    );
    const live =
      source !== null &&
      source.patientId === target.patientId &&
      source.typeKey === "dpoa_healthcare" &&
      source.status === "active";
    if (!live) return deny("dpoa_consent_not_active");
    actingConsentId = target.uploaderGrant.sourceConsentRecordId;
  }

  const signed = await deps.consent({
    organizationId,
    patientId: target.patientId,
    typeKey: target.docKind,
    grantorKind,
    actingConsentId,
    grantorRelationshipText: null,
    requestId,
    reviewerUserId,
    uploadedPdfDocumentId: target.documentId,
  });
  const marked = await deps.markAccepted(organizationId, requestId, {
    reviewerId: reviewerUserId,
    targetRef: signed.recordId,
    signerGrantKind: grantKind,
    signerRole: decision.signerRole,
  });
  return marked.ok ? { ok: true } : deny("request_not_pending_review");
}

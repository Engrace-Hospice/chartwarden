// M39 ADR-0107 (PROPOSED) — the portal sign seam: create a consent with the `electronic_portal_signature` capture method and sign it,
// idempotently. M31's `AdmissionDocumentSigners.consent` port is bound to this at the composition root.
//
// Idempotent: M39 signing and M31's request update are separate transactions, so a retry can find work already done. A retry first looks
// for a consent THIS REQUEST already created (the request id rides in the scope descriptor, so a later request for the same document never
// reuses an earlier signature) — an `active` one is returned as-is (nothing signed twice), a `draft` one is signed. `created_by_id` / `signed_by_id` carry the portal login's USER id: the column has no FK, but M39's audit
// trigger writes the same id as `audit_event.actor_user_id`, which does (a portal ACCOUNT id there fails the insert, found by the live
// suite). The human signer's typed name rides in the capture evidence; the account id is on the M31 request.
import type { ConsentRouteService } from "@chartwarden/consent";

export interface PortalConsentSignInput {
  readonly organizationId: string;
  readonly patientId: string;
  readonly typeKey: "hipaa_npp_acknowledgement" | "consent_to_treat";
  readonly grantorKind: "patient_self" | "dpoa_healthcare_agent" | "healthcare_surrogate";
  readonly actingConsentId: string | null;
  readonly grantorRelationshipText: string | null;
  /** The portal login's `user` id: recorded as creator and signer, and as the audit actor (the audit trigger's actor FK targets `user`). */
  readonly portalUserId: string;
  /** The M31 signature request this consent answers; binds the retry lookup to this request alone. */
  readonly requestId: string;
  readonly portalAccountId: string;
  readonly portalSessionId: string;
  readonly signerName: string;
  readonly existingConsentId: string | null;
}

/** Staff accepting an uploaded signed paper copy (ADR-0107 D6): the reviewer is creator and signer, the M22 document is the evidence. */
export interface UploadedCopyConsentInput {
  readonly organizationId: string;
  readonly patientId: string;
  readonly typeKey: "hipaa_npp_acknowledgement" | "consent_to_treat";
  readonly grantorKind: "patient_self" | "dpoa_healthcare_agent" | "healthcare_surrogate";
  readonly actingConsentId: string | null;
  readonly grantorRelationshipText: string | null;
  readonly requestId: string;
  readonly reviewerUserId: string;
  /** The M22 document the portal upload became; sealed into the consent's capture evidence. */
  readonly uploadedPdfDocumentId: string;
}

type PortalConsentService = Pick<
  ConsentRouteService,
  "getConsent" | "listConsentsForPatient" | "createDraft" | "signConsent" | "revokeConsent"
>;

/** Recorded on a consent revoked because the paper copy it answered was withdrawn or decided otherwise while it was being signed. */
export const UPLOADED_COPY_ORPHAN_REVOKE_REASON =
  "The signature request changed while this paper copy was being accepted, so the consent was not recorded against it.";

/** Input to revoke the uploaded-copy consents a request left active from a copy other than `keepDocumentId`. */
export interface UploadedCopyOrphanInput {
  readonly organizationId: string;
  readonly patientId: string;
  readonly requestId: string;
  readonly reviewerUserId: string;
  /** The copy whose consent stands (an accept in progress); null on reject / void, where none does. */
  readonly keepDocumentId: string | null;
  /** Revoke only this copy's consent (a reject refuses one copy; a newer copy may already be accepted). Omitted: every copy but `keepDocumentId`. */
  readonly onlyDocumentId?: string;
}

const scopeOf = (c: { scopeDescriptor?: unknown }) =>
  (c.scopeDescriptor ?? {}) as { requestId?: unknown; uploadedDocumentId?: unknown };

export function createPortalConsentSigner(service: PortalConsentService, nowIso: () => string) {
  type Known = { id: string; status: string } | null;

  async function revokeAsOrphan(
    organizationId: string,
    consentId: string,
    reviewerUserId: string,
    evidenceDocumentId: string,
  ): Promise<void> {
    try {
      await service.revokeConsent(
        organizationId,
        consentId,
        {
          actorIsStaff: true,
          revokedByKind: "staff",
          reasonText: UPLOADED_COPY_ORPHAN_REVOKE_REASON,
          evidenceDocumentId,
          revokedById: reviewerUserId,
        },
        nowIso(),
      );
    } catch (err) {
      // Two revokers (a reject's sweep and an accept's own rollback) can race on one consent; the loser's revoke is a no-op, not a failure.
      const now = await service.getConsent(organizationId, consentId);
      if (now?.status === "active") throw err;
    }
  }

  /**
   * Revoke every ACTIVE uploaded-copy consent this request holds from a copy other than `keepDocumentId`: what an accept leaves behind
   * when it signs in M39 and then fails before M31 records it (D2). Each is revoked with its own copy as evidence. A portal e-signed consent
   * (no `uploadedDocumentId` in its scope) is never touched. Returns how many were revoked.
   */
  async function revokeUploadedCopyOrphans(input: UploadedCopyOrphanInput): Promise<number> {
    const orphans = (
      await service.listConsentsForPatient(input.organizationId, input.patientId)
    ).filter((c) => {
      const scope = scopeOf(c);
      return (
        c.status === "active" &&
        scope.requestId === input.requestId &&
        typeof scope.uploadedDocumentId === "string" &&
        scope.uploadedDocumentId !== input.keepDocumentId &&
        (input.onlyDocumentId === undefined || scope.uploadedDocumentId === input.onlyDocumentId)
      );
    });
    for (const c of orphans) {
      await revokeAsOrphan(
        input.organizationId,
        c.id,
        input.reviewerUserId,
        scopeOf(c).uploadedDocumentId as string,
      );
    }
    return orphans.length;
  }

  /** The consent THIS request already created (retry-safe), else a fresh draft; then sign it. An active one is returned as-is. */
  async function findOrCreateAndSign(a: {
    organizationId: string;
    patientId: string;
    typeKey: PortalConsentSignInput["typeKey"];
    requestId: string;
    createdById: string;
    /** The portal sign path matches the consent its OWN signer created; an accepted upload matches on the request alone (any reviewer may retry). */
    matchCreator: boolean;
    /** An accepted upload also matches on the copy it was signed from, so a consent from another (rejected) copy is never reused. */
    uploadedDocumentId: string | null;
    existingConsentId: string | null;
    captureMethod: "electronic_portal_signature" | "uploaded_signed_pdf";
    grantorKind: PortalConsentSignInput["grantorKind"];
    actingConsentId: string | null;
    grantorRelationshipText: string | null;
    evidence: Parameters<PortalConsentService["signConsent"]>[4];
  }): Promise<{ recordId: string }> {
    const { organizationId } = a;
    const known: Known = a.existingConsentId
      ? await service.getConsent(organizationId, a.existingConsentId)
      : ((await service.listConsentsForPatient(organizationId, a.patientId)).find(
          (c) =>
            c.typeKey === a.typeKey &&
            (!a.matchCreator || c.createdById === a.createdById) &&
            scopeOf(c).requestId === a.requestId &&
            (a.uploadedDocumentId === null ||
              scopeOf(c).uploadedDocumentId === a.uploadedDocumentId) &&
            (c.status === "draft" || c.status === "active"),
        ) ?? null);
    if (known?.status === "active") return { recordId: known.id };

    const draft =
      known?.status === "draft"
        ? known
        : await service.createDraft(organizationId, {
            patientId: a.patientId,
            typeKey: a.typeKey,
            grantorKind: a.grantorKind,
            captureMethod: a.captureMethod,
            scopeDescriptor: {
              kind: "categorical",
              documentKind: a.typeKey,
              requestId: a.requestId,
              ...(a.uploadedDocumentId === null
                ? {}
                : { uploadedDocumentId: a.uploadedDocumentId }),
            },
            createdById: a.createdById,
            grantorRelationshipText: a.grantorRelationshipText,
            actingConsentId: a.actingConsentId,
          });
    const signed = await service.signConsent(
      organizationId,
      draft.id,
      a.createdById,
      nowIso(),
      a.evidence,
    );
    return { recordId: signed.id };
  }

  return {
    sign(input: PortalConsentSignInput): Promise<{ recordId: string }> {
      return findOrCreateAndSign({
        ...input,
        createdById: input.portalUserId,
        matchCreator: true,
        uploadedDocumentId: null,
        captureMethod: "electronic_portal_signature",
        evidence: { portalSessionId: input.portalSessionId, typedSignatureName: input.signerName },
      });
    },
    async revokeUploadedCopy(input: {
      organizationId: string;
      consentId: string;
      reviewerUserId: string;
      evidenceDocumentId: string;
    }): Promise<void> {
      await revokeAsOrphan(
        input.organizationId,
        input.consentId,
        input.reviewerUserId,
        input.evidenceDocumentId,
      );
    },
    revokeUploadedCopyOrphans,
    async acceptUploadedCopy(input: UploadedCopyConsentInput): Promise<{ recordId: string }> {
      // A consent an earlier, failed accept signed from a DIFFERENT copy of this request must not stay active beside this one.
      await revokeUploadedCopyOrphans({
        organizationId: input.organizationId,
        patientId: input.patientId,
        requestId: input.requestId,
        reviewerUserId: input.reviewerUserId,
        keepDocumentId: input.uploadedPdfDocumentId,
      });
      return findOrCreateAndSign({
        ...input,
        createdById: input.reviewerUserId,
        matchCreator: false,
        uploadedDocumentId: input.uploadedPdfDocumentId,
        existingConsentId: null,
        captureMethod: "uploaded_signed_pdf",
        evidence: { uploadedPdfDocumentId: input.uploadedPdfDocumentId },
      });
    },
  };
}

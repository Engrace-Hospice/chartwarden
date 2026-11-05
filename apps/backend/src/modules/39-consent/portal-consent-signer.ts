// M39 ADR-0107 (PROPOSED) — the portal sign seam: create a consent with the `electronic_portal_signature` capture method and sign it,
// idempotently. M31's `AdmissionDocumentSigners.consent` port is bound to this at the composition root.
//
// Idempotent: M39 signing and M31's request update are separate transactions, so a retry can find work already done. A retry first looks
// for a consent of this type the SAME portal account already created for the patient — an `active` one is returned as-is (nothing signed
// twice), a `draft` one is signed. `consent_record.created_by_id` / `signed_by_id` are plain uuids (no FK), so the portal account id is
// recorded there; the human signer's typed name rides in the capture evidence.
import type { ConsentRouteService } from "@chartwarden/consent";

export interface PortalConsentSignInput {
  readonly organizationId: string;
  readonly patientId: string;
  readonly typeKey: "hipaa_npp_acknowledgement" | "consent_to_treat";
  readonly grantorKind: "patient_self" | "dpoa_healthcare_agent" | "healthcare_surrogate";
  readonly actingConsentId: string | null;
  readonly grantorRelationshipText: string | null;
  readonly portalAccountId: string;
  readonly portalSessionId: string;
  readonly signerName: string;
  readonly existingConsentId: string | null;
}

type PortalConsentService = Pick<
  ConsentRouteService,
  "getConsent" | "listConsentsForPatient" | "createDraft" | "signConsent"
>;

export function createPortalConsentSigner(service: PortalConsentService, nowIso: () => string) {
  return {
    async sign(input: PortalConsentSignInput): Promise<{ recordId: string }> {
      const { organizationId, portalAccountId } = input;
      const known = input.existingConsentId
        ? await service.getConsent(organizationId, input.existingConsentId)
        : ((await service.listConsentsForPatient(organizationId, input.patientId)).find(
            (c) =>
              c.typeKey === input.typeKey &&
              c.createdById === portalAccountId &&
              (c.status === "draft" || c.status === "active"),
          ) ?? null);
      if (known?.status === "active") return { recordId: known.id };

      const draft =
        known?.status === "draft"
          ? known
          : await service.createDraft(organizationId, {
              patientId: input.patientId,
              typeKey: input.typeKey,
              grantorKind: input.grantorKind,
              captureMethod: "electronic_portal_signature",
              scopeDescriptor: { kind: "categorical", documentKind: input.typeKey },
              createdById: portalAccountId,
              grantorRelationshipText: input.grantorRelationshipText,
              actingConsentId: input.actingConsentId,
            });
      const signed = await service.signConsent(organizationId, draft.id, portalAccountId, nowIso(), {
        portalSessionId: input.portalSessionId,
        typedSignatureName: input.signerName,
      });
      return { recordId: signed.id };
    },
  };
}

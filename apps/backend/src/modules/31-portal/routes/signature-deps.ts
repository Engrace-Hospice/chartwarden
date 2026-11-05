import type { AcceptUploadedCopyDeps } from "../write-paths/accept-uploaded-copy";
// M31 ADR-0107 (PROPOSED) - the signing ports the composition root binds. Its own file so `routes/index.ts` (which names the type on
// `PortalRouteDeps`) and `signature.routes.ts` (which imports `PortalRouteDeps` from there) do not import each other.
import type {
  AdmissionDocumentSigners,
  ConsentStatusReader,
} from "../write-paths/sign-admission-document";
import type { StaffSignatureStore } from "./signature-staff-store";
import type { PortalSignatureStore } from "./signature-store";

/** The ports behind the STAFF create / list / void routes (the composition root binds them to M5 and M06). */
export interface PortalStaffSigningDeps {
  readonly store: StaffSignatureStore;
  /** M39 seam: record an ACCEPTED uploaded paper copy as a consent (uploaded signed PDF; the reviewer is creator and signer). */
  readonly uploadedCopyConsent: AcceptUploadedCopyDeps["consent"];
  /** M39 seam: revoke a consent an accept signed but could not record (the request changed meanwhile). */
  readonly revokeUploadedCopyConsent: AcceptUploadedCopyDeps["revokeConsent"];
  /** The patient's agency and service location (M5's reader). null when the patient is unknown or has no agency: a request is never created unsited. */
  readonly patientSite: (
    organizationId: string,
    patientId: string,
  ) => Promise<{ readonly providerEntityId: string; readonly locationId: string | null } | null>;
  /** True when `targetRef` is what an M06 document signs INTO for this patient: a still-drafted election statement, or an admission with no notice acknowledged. */
  readonly m06TargetIsSignable: (input: {
    readonly organizationId: string;
    readonly docKind: "election_statement" | "notice_of_patient_rights";
    readonly patientId: string;
    readonly targetRef: string;
  }) => Promise<boolean>;
}

/** The signing ports the composition root binds (M06 / M39 adapters, the M39 status read, the template-review switch). */
export interface PortalSigningDeps {
  readonly store: PortalSignatureStore;
  readonly signers: AdmissionDocumentSigners;
  readonly consents: ConsentStatusReader;
  /** The tenant's agency display name for the document wording; null when unresolved (the wording then says "your hospice"). */
  readonly agencyName: (organizationId: string) => Promise<string | null>;
  /** false on production tenants: a "pending legal review" template cannot be signed. */
  readonly allowUnreviewedTemplates: boolean;
  /** Staff routes; absent ⇒ they answer 503 rather than create requests nobody can verify. */
  readonly staff?: PortalStaffSigningDeps;
}

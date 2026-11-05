// M31 ADR-0107 (PROPOSED) - the signing ports the composition root binds. Its own file so `routes/index.ts` (which names the type on
// `PortalRouteDeps`) and `signature.routes.ts` (which imports `PortalRouteDeps` from there) do not import each other.
import type {
  AdmissionDocumentSigners,
  ConsentStatusReader,
} from "../write-paths/sign-admission-document";
import type { PortalSignatureStore } from "./signature-store";

/** The signing ports the composition root binds (M06 / M39 adapters, the M39 status read, the template-review switch). */
export interface PortalSigningDeps {
  readonly store: PortalSignatureStore;
  readonly signers: AdmissionDocumentSigners;
  readonly consents: ConsentStatusReader;
  /** false on production tenants: a "pending legal review" template cannot be signed. */
  readonly allowUnreviewedTemplates: boolean;
}

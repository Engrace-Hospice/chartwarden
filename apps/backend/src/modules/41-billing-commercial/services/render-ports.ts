// apps/backend/src/modules/41-billing-commercial/services/render-ports.ts - the production binding of the 837I renderer's ports.
//
// SUBSCRIBER IDENTITY is bound over M5's `PatientReader` and `PatientAddressReader` seams (M41 reads no patient table). It is read for
// ONE render, handed to the builder and dropped: never stored, never logged. A missing field is a null (the renderer reports the typed
// gap `subscriber`), never a guess.
//
// PARTIES (submitter, receiver, billing provider, payer name) have NO production source yet: M23's own loader leaves the same port
// unbound. Until a platform submitter/receiver and provider-entity party reader exist, `partiesFor` answers null and the renderer
// reports the gap `parties`, so a send ends `failed` (COMMERCIAL_837I_INCOMPLETE) and the claim stays `ready`. Nothing is invented.
// Pass `parties` to bind a real reader.
import type { PatientAddressReader, PatientReader } from "@chartwarden/types";
import type { CommercialRenderPorts, CommercialSubscriberIdentity } from "./render-837i";

export interface CommercialRenderPortDeps {
  readonly coverage: CommercialRenderPorts["coverage"];
  readonly caseload: CommercialRenderPorts["caseload"];
  /** Resolved lazily per call (boot registration order never matters). */
  readonly patients: () => Pick<PatientReader, "findById">;
  readonly addresses: () => Pick<PatientAddressReader, "primaryAddress">;
  readonly parties?: CommercialRenderPorts["parties"];
}

export function buildCommercialRenderPorts(deps: CommercialRenderPortDeps): CommercialRenderPorts {
  return {
    coverage: deps.coverage,
    caseload: deps.caseload,
    identity: {
      async identityFor({
        organizationId,
        patientId,
      }): Promise<CommercialSubscriberIdentity | null> {
        const patient = await deps.patients().findById({ organizationId, id: patientId });
        if (!patient || (patient.administrativeSex !== "M" && patient.administrativeSex !== "F")) {
          return null;
        }
        const address = await deps.addresses().primaryAddress(organizationId, patientId);
        if (!address || address.state === null) return null;
        return {
          lastName: patient.lastName,
          firstName: patient.firstName,
          dateOfBirth: patient.dateOfBirth,
          sex: patient.administrativeSex,
          address: {
            line1: address.line1,
            ...(address.line2 === null ? {} : { line2: address.line2 }),
            city: address.city,
            state: address.state,
            postalCode: address.postalCode,
          },
        };
      },
    },
    parties: deps.parties ?? { partiesFor: async () => null },
  };
}

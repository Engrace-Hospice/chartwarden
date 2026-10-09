// apps/backend/src/modules/06-admission/render-payloads/sources.ts - the ports the M6 render-payload producers
// read the facts a signed CoP document must carry but M6 does not own: the patient's name / MRN / DOB (M5) and
// a physician's printed name, credentials and NPI (M40). Resolved through the owning modules' published seams
// (never their tables), exactly as the election-addendum prefill does.
import { getSeam } from "../../../bootstrap/index";
import { getMdmEntityProvider } from "../../40-mdm/seams";

export interface RenderPatientFacts {
  readonly name: string;
  readonly mrn: string;
  readonly dateOfBirth: string | null;
}

export interface RenderPhysicianFacts {
  readonly name: string;
  readonly credentials: string | null;
  readonly npi: string | null;
}

export interface RenderSourcesPort {
  patient(organizationId: string, patientId: string): Promise<RenderPatientFacts | null>;
  physician(organizationId: string, physicianId: string): Promise<RenderPhysicianFacts | null>;
}

/** Raised when a typed render payload cannot be built (a source did not resolve). The call site omits the
 *  payload and logs ids only; M22 then refuses the id-only event (DLQ) instead of drawing a blank form. */
export class RenderPayloadBuildError extends Error {
  readonly code = "RENDER_PAYLOAD_UNAVAILABLE";
  constructor(
    readonly artifact: string,
    readonly why: string,
  ) {
    super(`${artifact} render payload could not be built: ${why}`);
    this.name = "RenderPayloadBuildError";
  }
}

/**
 * The production sources: M5's `PatientReader` and M40's `MdmEntityProvider`, resolved lazily per call. A seam that
 * is not registered or throws reads as "did not resolve" (null): the builder then reports it by name and the signing
 * transaction is never failed by a lookup - the document is refused downstream instead, loudly.
 */
export function createSeamRenderSources(): RenderSourcesPort {
  return {
    async patient(organizationId, patientId) {
      try {
        const p = await getSeam("PatientReader").findById({ organizationId, id: patientId });
        if (!p) return null;
        return {
          name: `${p.firstName} ${p.lastName}`.trim(),
          mrn: p.mrn,
          dateOfBirth: p.dateOfBirth ?? null,
        };
      } catch {
        return null;
      }
    },
    async physician(organizationId, physicianId) {
      try {
        const r = await getMdmEntityProvider().resolvePhysician(organizationId, physicianId);
        if (!r) return null;
        const { canonical } = r;
        return {
          name: canonical.displayName,
          credentials: canonical.credentials,
          npi: canonical.identifierType === "npi" ? canonical.identifierValue : null,
        };
      } catch {
        return null;
      }
    },
  };
}

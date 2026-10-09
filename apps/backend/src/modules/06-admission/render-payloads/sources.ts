// apps/backend/src/modules/06-admission/render-payloads/sources.ts - the ports the M6 render-payload producers
// read the facts a signed CoP document must carry but M6 does not own: the patient's name / MRN / DOB (M5) and
// a physician's printed name, credentials and NPI (M40). The implementation is shared Foundation code
// (bootstrap/render-payload-sources.ts) so M6, M11 and M12 build identical facts; re-exported here so M6's own
// call sites and tests keep their import path.
export {
  RenderPayloadBuildError,
  createSeamRenderSources,
} from "../../../bootstrap/render-payload-sources";
export type {
  RenderPatientFacts,
  RenderPhysicianFacts,
  RenderSourcesPort,
} from "../../../bootstrap/render-payload-sources";

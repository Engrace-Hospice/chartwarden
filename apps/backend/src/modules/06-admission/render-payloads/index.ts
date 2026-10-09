// apps/backend/src/modules/06-admission/render-payloads/index.ts - M6's typed render-payload producers (GAP-033).
export {
  buildCtiRenderPayload,
  buildDischargeRenderPayload,
  buildF2fRenderPayload,
  buildNorRenderPayload,
  buildOrOmit,
  buildRevocationRenderPayload,
  buildTransferRenderPayload,
} from "./build";
export type { RenderBuildCtx } from "./build";
export {
  RenderPayloadBuildError,
  createSeamRenderSources,
} from "./sources";
export type { RenderPatientFacts, RenderPhysicianFacts, RenderSourcesPort } from "./sources";

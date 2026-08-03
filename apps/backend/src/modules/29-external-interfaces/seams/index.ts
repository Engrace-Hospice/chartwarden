// apps/backend/src/modules/29-external-interfaces/seams — M29's seam boundary (§4.4, M29-T08).
//
// `registerM29PublishedSeams` is §4.4's boot registration, driven from the composition root's
// `wireModuleSeams()` and therefore before `validateSeams()`. Without a store it is a NO-OP and the M1
// fail-closed deny-stubs stand (the M28/M19/M20 "no store ⇒ register nothing" posture).
export {
  createExternalFeedReader,
  createExternalInterfaceMetricsProvider,
  createHl7InboundProposalReader,
  createLabObservationReader,
  createNppesProviderReader,
  registerM29PublishedSeams,
  type ExternalFeedReader,
  type FeedHealthSeamDTO,
  type FeedSeamSummary,
  type Hl7InboundProposalReader,
  type InboundProposalSeamDTO,
  type LabObservationReader,
  type LabObservationSeamDTO,
  type M29PublishedSeamDeps,
  type M29PublishedSeamStore,
  type NppesProviderReader,
  type NppesProviderSeamDTO,
} from "./published";
export { createDrizzleM29PublishedSeamStore } from "./published-store-drizzle";

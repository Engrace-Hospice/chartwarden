// apps/backend/src/modules/29-external-interfaces/routes — M29's HTTP surface barrel (§4.1/§4.2, M29-T08).
export {
  mountM29Routes,
  type M29RouteServices,
  registerFeedRoutes,
  registerLabRoutes,
  registerMessageRoutes,
  registerNppesRoutes,
  registerOpsRoutes,
  registerProposalRoutes,
  type FeedRouteDeps,
  type LabRouteDeps,
  type MessageRouteDeps,
  type NppesRouteDeps,
  type OpsRouteDeps,
  type ProposalRouteDeps,
} from "./mount";
export {
  M29StoreError,
  createInMemoryM29Store,
  type M29Store,
  type FeedDetail,
  type FeedSummary,
  type ProposalDetail,
  type LabObservationDetail,
} from "./store";
export { createDrizzleM29Store } from "./store-drizzle";

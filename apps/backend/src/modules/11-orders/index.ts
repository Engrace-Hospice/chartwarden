// apps/backend/src/modules/11-orders — M11 (Orders) backend module surface.
//
// M11-T05 lands the two §2.8 D14 / §4.3 owned seams (OrderSignatureProvider — the polymorphic clinical-
// signature WRITE primitive M12 routes medication-order signatures through — + OrderProvider — the read-side
// counterpart M14/M23/M30/M7 consume) registered into the M1 registry via `registerOrderSeams` (driven from
// the composition root's wireModuleSeams()).
export {
  type InsertCosignatureInput,
  type InsertDiscontinuationInput,
  type InsertSignatureInput,
  type InsertVerbalOrderInput,
  type OrderSeamDeps,
  type OrderSeamSeed,
  type OrderSeamStore,
  type VerbalSeedRow,
  type VerbalTimeliness,
  createInMemoryOrderSeamStore,
  createOrderProvider,
  createOrderSignatureProvider,
  getOrderMdmValidator,
  getOrderProvider,
  getOrderSignatureProvider,
  getOrderTerminologyValidator,
  registerOrderSeams,
} from "./seams/index";
// M11-T06 — the §4.1 route inventory over an in-memory backend + the §4.7 ABAC predicates M11 owns
// (`discipline_can_order` / `signer_eligible` / `cosigner_role_match`). The §4.6 permission keys M11
// contributes to M3 live in @wardenx/auth (M11_CONTRIBUTED_PERMISSIONS).
export {
  type OrderAbacDeps,
  M11_ABAC_PREDICATES,
  buildOrderAbacPredicates,
  orderDisciplinesOf,
  registerOrderAbacPredicates,
} from "./abac-predicates";
export { type OrderRouteDeps, registerOrderRoutes } from "./routes/orders-routes";
export {
  type CreateOrderArgs,
  type CreateStandingArgs,
  type OrderAbacFacts,
  type OrderAbacResolver,
  type OrderMdmValidator,
  type OrderRouteSeed,
  type OrderRouteService,
  type OrderTerminologyValidator,
  type OrderView,
  type RecordedOrderEvent,
  type StandingOrderView,
  type VerbalPolicyView,
  createInMemoryOrderBackend,
} from "./routes/service";

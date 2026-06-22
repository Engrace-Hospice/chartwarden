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
  getOrderProvider,
  getOrderSignatureProvider,
  registerOrderSeams,
} from "./seams/index";

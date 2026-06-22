// apps/backend/src/modules/11-orders/seams — M11's published §2.8 D14 / §4.3 owned seams (M11-T05). M11
// publishes TWO leaf-typed surfaces forward consumers attach to instead of importing M11's schema
// (architecture §11 blocks the schema import): `OrderSignatureProvider` — the polymorphic clinical-signature
// WRITE primitive M12 routes medication-order signatures through (D4; no SQL FK across the discriminator) —
// and `OrderProvider` — the read-side counterpart M14 (orders since last IDG), M23 ("every billed line has a
// covering order" rule), M30 (order-completion + verbal-order-timeliness HQRP measures), and M7 (care-plan
// intervention → order back-ref) consume. `registerOrderSeams` registers both real impls over their boot
// deny-stubs (before validateSeams()), driven from the composition root's wireModuleSeams(). Both share ONE
// injected OrderSeamStore (in-memory slice here; Drizzle in prod, reads/writes under the consumer's RLS) —
// mirrors the M8/M9/M10 seams/index.ts precedents.
import type { OrderProvider, OrderSignatureProvider } from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import { createOrderProvider, createOrderSignatureProvider } from "./providers";
import { type OrderSeamStore, createInMemoryOrderSeamStore } from "./store";

export {
  type InsertCosignatureInput,
  type InsertDiscontinuationInput,
  type InsertSignatureInput,
  type InsertVerbalOrderInput,
  type OrderSeamSeed,
  type OrderSeamStore,
  type VerbalSeedRow,
  type VerbalTimeliness,
  createInMemoryOrderSeamStore,
} from "./store";
export { createOrderProvider, createOrderSignatureProvider } from "./providers";

/** Deps for M11's owned-seam registration (slice defaults to the in-memory store). */
export interface OrderSeamDeps {
  /** The §2.8 / §4.3 data port (Drizzle over M11's tables in prod; in-memory slice in tests). */
  store?: OrderSeamStore;
}

/**
 * Register M11's two §2.8 D14 / §4.3 owned seams into the M1 registry over their boot deny-stubs (M11-T05;
 * before validateSeams()). Both share one {@link OrderSeamStore} so a single Drizzle adapter backs the whole
 * order signature/read surface. Called by the composition root's wireModuleSeams().
 */
export function registerOrderSeams(deps: OrderSeamDeps = {}): void {
  const store = deps.store ?? createInMemoryOrderSeamStore().store;
  registerSeam("OrderSignatureProvider", createOrderSignatureProvider(store));
  registerSeam("OrderProvider", createOrderProvider(store));
}

/** Typed resolver for M11's OrderSignatureProvider (M12 consumes it for the med-order signature primitive). */
export function getOrderSignatureProvider(): OrderSignatureProvider {
  return getSeam("OrderSignatureProvider");
}

/** Typed resolver for M11's OrderProvider (M14/M23/M30/M7 consume the read-side seam). */
export function getOrderProvider(): OrderProvider {
  return getSeam("OrderProvider");
}

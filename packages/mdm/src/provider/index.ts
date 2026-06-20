// @wardenx/mdm — the MdmEntityProvider seam + its data port (M40-T05, §4.5).
// The real provider (pure orchestration over the T04 engine) + the `MdmStore` port and its
// in-memory slice default. M40 registers `createMdmEntityProvider(store)` into the M1 registry
// at boot; T07 supplies the Drizzle-backed store.

export { createMdmEntityProvider } from "./provider";
export {
  createInMemoryMdmStore,
  type MdmStore,
  type InMemoryMdmSeed,
  type SeedCanonical,
  type SeedOverlay,
  type SeedRelationship,
  type SeedBaa,
} from "./store";

// @wardenx/mdm — the BaaStatusProvider seam: §7.7 disclosure gate (M40-T06, §4.6).
// The pure as-of decision engine + the focused provider + its `BaaStore` port and in-memory slice.
// M40 registers `createBaaStatusProvider(store)` into the M1 registry at boot; T07 supplies the
// Drizzle-backed store.

export { decideBaaStatus, defaultBaaRequired, NO_MATCH_RESULT, type BaaRecordRow } from "./gate";
export { createBaaStatusProvider } from "./provider";
export {
  createInMemoryBaaStore,
  type BaaStore,
  type InMemoryBaaSeed,
  type SeedBaaFacility,
  type SeedBaaRequired,
  type SeedBaaRecord,
} from "./store";

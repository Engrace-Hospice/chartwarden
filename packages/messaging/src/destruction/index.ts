// @chartwarden/messaging — D9 tenant-offboarding destruction (M36-T10, spec §7.8 / §11 D9).
export {
  eraseTenantMessaging,
  type MessagingEraseStore,
  type MessagingEraseResult,
} from "./eraseFn";
export {
  createInMemoryMessagingEraseStore,
  DekDestroyedError,
  type MessagingEraseSeed,
  type SeedMessage,
  type SeedStructuralRow,
  type SeedCrossTenantRow,
  type InMemoryMessagingEraseStore,
} from "./in-memory-erase-store";

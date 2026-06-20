// apps/backend/src/modules/36-messaging/erasers/messaging-eraser.ts — M36-T10 the `messages`
// data eraser (spec §7.8 / §11 D9).
//
// M36 owns the destruction path for the `messages` PHI data class, so it registers the REAL eraser
// over the Phase-0 deny-stub (bootstrap REQUIRED_ERASERS + wireErasers()); the composition root
// invokes registerMessagingErasers() through buildServer's `registerModuleErasers` hook, which runs
// AFTER wireErasers() and before validateErasers(), so the real eraser stands and a
// tenant-offboarding / right-to-erasure request hits a working eraser, not a silent no-op (mirrors
// the M2 identity, M4 audit, and M38 terminology erasers).
//
// The actual destruction is the pure `eraseTenantMessaging` (packages/messaging/src/destruction):
// it destroys the tenant DEK FIRST — cryptographic erasure that makes every `message.body_cipher`
// for the tenant undecryptable (§7.8, architecture §8(2)) — then deletes the org-scoped structural
// rows, then the cross-tenant user rows (presence / delivery_endpoint / user_notification_preferences)
// ONLY for users whose sole membership was the offboarded tenant (the D9 "a user is not the tenant"
// carve-out). Like the rest of the slice it runs over an injected store with an in-memory default;
// production injects the Drizzle-backed store + the M1 key vault (DEK destruction is a key-vault op,
// not a row UPDATE), and M4 files the destruction certificate for `messaging_tenant_data`.
import {
  type MessagingEraseStore,
  createInMemoryMessagingEraseStore,
  eraseTenantMessaging,
} from "@wardenx/messaging";
import type { DataEraser } from "@wardenx/types";
import { registerEraser } from "../../../bootstrap/index";

/** Injected adapter for the M36 eraser (slice defaults to the in-memory messaging-erase store). */
export interface MessagingEraserDeps {
  /** The data port deletes run over (Drizzle + M1 key vault in production; in-memory by default). */
  store?: MessagingEraseStore;
}

/**
 * Build M36's `messages` DataEraser. The destruction registry hands `subjectId` = the offboarding
 * org id; the eraser cryptographically erases that org's message bodies (DEK destruction) and reports
 * the faithful total rows accounted for (bodies rendered unreadable + structural + cross-tenant).
 */
export function createMessagingEraser(store: MessagingEraseStore): DataEraser {
  return {
    async erase(scope, subjectId) {
      // The data class is org-scoped: both `scope.orgId` and the offboarding `subjectId` name the
      // org. Erase by the subject (the offboarding org), consistent with the M2/M4/M38 erasers.
      void scope;
      const result = await eraseTenantMessaging(subjectId, store);
      return { erased: result.erased };
    },
  };
}

/**
 * Register M36's REAL `messages` eraser into the M1 destruction-cert registry over the Phase-0
 * deny-stub (M36-T10). Called by the composition root's wireModuleErasers() AFTER wireErasers()
 * and before validateErasers(), so the real eraser stands.
 */
export function registerMessagingErasers(deps: MessagingEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryMessagingEraseStore().store;
  registerEraser("messages", createMessagingEraser(store));
}
